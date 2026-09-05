import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount, type ResolvedAccount } from "./shared.js";
import { authLogin } from "./auth.js";
import { AuthRequiredError } from "../core/errors.js";
import { runWorkScan } from "../core/orchestrator.js";
import { RandomClassifier } from "../ai/random-classifier.js";
import { RuleGroupsRepository } from "../state/repositories/rule-groups.js";
import { RunsRepository, ActionsRepository } from "../state/repositories/runs.js";
import { CalendarLinksRepository } from "../state/repositories/calendar-links.js";
import { buildPlannedActions } from "../core/action-plan.js";
import { POLICY_VERSION } from "../core/policy.js";
import { renderHumanSummary } from "../summary/render-human.js";
import { renderJsonSummary } from "../summary/render-json.js";
import { EXIT_CODES } from "../core/errors.js";
import { newRunId } from "../core/ids.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import {
  applyGroupedLabelMutations,
  archiveMutation,
  combineMutations,
  markImportantOnlyMutation,
  starOnlyMutation,
  trashMessage
} from "../gmail/executor.js";
import { buildEventInsertPlan, insertIdempotentEvent } from "../calendar/idempotency.js";
import { withGoogleApiRetry } from "../core/google-api-retry.js";
import { contentHash } from "../core/ids.js";
import type { PolicyActionIntent } from "../core/policy.js";
import type { ActionType, PlannedAction } from "../core/models.js";

const RANDOM_CLASSIFIER_WARNING =
  pc.yellow("⚠ AI classification is a RANDOM placeholder in this build.\n") +
  pc.yellow(
    "  It makes meaningless trash/star/archive/calendar decisions. Do not run this against a\n" +
      "  real mailbox you care about — use --dry-run first, or a throwaway test account.\n" +
      "  See src/ai/random-classifier.ts for where to plug in a real filter."
  );

export interface WorkOptions {
  dryRun: boolean;
  json: boolean;
  /** Caps the Inbox and native-Spam scans to this many most-recent messages each, to bound Gmail API quota usage. */
  limit?: number;
}

function mutationForActions(actions: readonly PolicyActionIntent[]) {
  const mutations = actions
    .filter((a): a is Extract<PolicyActionIntent, { type: "star" | "mark_important" | "archive" }> =>
      a.type === "star" || a.type === "mark_important" || a.type === "archive"
    )
    .map((a) => {
      if (a.type === "star") return starOnlyMutation();
      if (a.type === "mark_important") return markImportantOnlyMutation();
      return archiveMutation();
    });
  return combineMutations(mutations);
}

async function resolveAccountSigningInIfNeeded(ctx: ReturnType<typeof bootstrap>): Promise<ResolvedAccount> {
  try {
    return await resolveAccount(ctx);
  } catch (error) {
    if (!(error instanceof AuthRequiredError)) {
      throw error;
    }
    // `gmail` on its own is the whole onboarding experience — no separate
    // `gmail auth login` command in this build. First run signs you in
    // right here, inline, then continues straight into the scan.
    const loginExitCode = await authLogin();
    if (loginExitCode !== 0) {
      throw error;
    }
    return resolveAccount(ctx);
  }
}

export async function runWork(options: WorkOptions): Promise<number> {
  const ctx = bootstrap();
  const { account, gmailClient, calendarClient } = await resolveAccountSigningInIfNeeded(ctx);

  // Always goes to stderr, even in --json mode: it never touches stdout,
  // so it can't corrupt a piped JSON summary, and this warning is too
  // important to hide from a human who happens to be running --json.
  console.error(RANDOM_CLASSIFIER_WARNING);

  const lock = options.dryRun ? null : new ProcessLock(lockFilePath(account.accountHash));
  lock?.acquire();

  try {
    const ruleGroups = new RuleGroupsRepository(ctx.db).listEnabled(account.accountHash);

    const { summary, outcomes, scanNote } = await runWorkScan({
      gmailClient,
      classifier: new RandomClassifier(),
      ruleGroups,
      userEmail: account.emailDisplay ?? "",
      userTimezone: account.timezone,
      clock: ctx.clock,
      concurrency: { gmailReads: 5 },
      ...(options.limit !== undefined ? { limit: options.limit } : {})
    });

    let runId: string | undefined;
    let failureCount = 0;

    if (!options.dryRun) {
      runId = newRunId();
      const nowIso = ctx.clock.nowIso();
      const runsRepo = new RunsRepository(ctx.db);
      const actionsRepo = new ActionsRepository(ctx.db);

      // Reconcile any action left `applying` by a crashed prior run before
      // planning new ones. The remote result of an interrupted mutation
      // cannot be safely queried, so it is marked unknown and never retried
      // automatically.
      for (const stale of actionsRepo.findApplying(account.accountHash)) {
        actionsRepo.updateStatus(stale.actionKey, "unknown_no_retry", nowIso, "crash_reconciliation");
      }

      runsRepo.create({
        runId,
        accountHash: account.accountHash,
        mode: "work",
        policyVersion: POLICY_VERSION,
        classifierVersion: null,
        promptVersion: null,
        schemaVersion: null,
        startedAt: nowIso,
        finishedAt: null,
        status: "running",
        counters: {},
        errorSummary: null
      });

      const trashTargets: string[] = [];
      const labelTargets: { messageId: string; mutation: ReturnType<typeof mutationForActions> }[] = [];
      const actionsByMessageId = new Map<string, PlannedAction[]>();

      for (const outcome of outcomes) {
        const isTrash = outcome.decision.actions.some((a) => a.type === "trash");
        const planned = buildPlannedActions(outcome.decision.actions, {
          runId,
          accountHash: account.accountHash,
          gmailMessageId: outcome.gmailMessageId,
          gmailThreadId: outcome.gmailThreadId,
          beforeStateHash: contentHash(JSON.stringify([...outcome.labelIdsAtSnapshot].sort())),
          nowIso
        });
        if (planned.length > 0) {
          actionsRepo.upsertPlanned(planned);
          actionsByMessageId.set(outcome.gmailMessageId, planned);
        }
        if (isTrash) {
          trashTargets.push(outcome.gmailMessageId);
        } else {
          const mutation = mutationForActions(outcome.decision.actions);
          if (mutation.addLabelIds.length > 0 || mutation.removeLabelIds.length > 0) {
            labelTargets.push({ messageId: outcome.gmailMessageId, mutation });
          }
        }
      }

      // Moves this message's action-ledger rows of the given type(s) to a
      // new status. A row already reconciled to a terminal status by
      // upsertPlanned's own guard is simply re-set here, which is fine
      // since this function is the one actually executing right now.
      const markActions = (
        messageId: string,
        types: readonly ActionType[],
        status: PlannedAction["status"],
        errorClass: string | null = null
      ): void => {
        for (const row of actionsByMessageId.get(messageId) ?? []) {
          if (types.includes(row.type)) {
            actionsRepo.updateStatus(row.actionKey, status, ctx.clock.nowIso(), errorClass);
          }
        }
      };

      // Immediately before mutating, re-fetch current label state so a
      // change the user made after the snapshot (e.g. starring a message)
      // is respected rather than overwritten.
      const survivingTrash: string[] = [];
      for (const messageId of trashTargets) {
        try {
          const { data } = await withGoogleApiRetry(() =>
            gmailClient.users.messages.get({
              userId: "me",
              id: messageId,
              format: "minimal"
            })
          );
          const labels = data.labelIds ?? [];
          if (labels.includes("STARRED") || labels.includes("IMPORTANT")) {
            markActions(messageId, ["trash"], "skipped_conflict");
            continue; // user protected it after the snapshot; skip this trash.
          }
          survivingTrash.push(messageId);
        } catch {
          markActions(messageId, ["trash"], "failed_retryable", "precondition_check_failed");
          failureCount += 1;
        }
      }

      for (const messageId of survivingTrash) {
        markActions(messageId, ["trash"], "applying");
        try {
          await trashMessage(gmailClient, messageId);
          markActions(messageId, ["trash"], "applied");
        } catch {
          markActions(messageId, ["trash"], "failed_retryable", "gmail_api_error");
          failureCount += 1;
        }
      }

      for (const { messageId } of labelTargets) {
        markActions(messageId, ["star", "mark_important", "archive"], "applying");
      }
      const labelResult = await applyGroupedLabelMutations(gmailClient, labelTargets);
      for (const messageId of labelResult.succeededMessageIds) {
        markActions(messageId, ["star", "mark_important", "archive"], "applied");
      }
      for (const messageId of labelResult.failedMessageIds) {
        markActions(messageId, ["star", "mark_important", "archive"], "failed_retryable", "gmail_api_error");
        failureCount += 1;
      }

      // Calendar creation: only for outcomes whose event candidate already
      // passed real-code date/shape validation (see orchestrator.ts). The
      // deterministic event ID makes this safe to run every time — a
      // repeat for the same message/candidate never creates a duplicate.
      const calendarLinksRepo = new CalendarLinksRepository(ctx.db);
      let calendarCreated = 0;
      for (const outcome of outcomes) {
        if (!outcome.validatedEvent || survivingTrash.includes(outcome.gmailMessageId)) {
          continue;
        }
        markActions(outcome.gmailMessageId, ["calendar_create"], "applying");
        const plan = buildEventInsertPlan({
          accountHash: account.accountHash,
          gmailMessageId: outcome.gmailMessageId,
          gmailThreadId: outcome.gmailThreadId,
          classifierVersion: outcome.classifierVersion ?? "unknown",
          candidateIndex: 0,
          event: outcome.validatedEvent
        });
        try {
          const insertResult = await insertIdempotentEvent(calendarClient, plan);
          if (insertResult.kind === "inserted" || insertResult.kind === "already_applied_by_this_app") {
            calendarLinksRepo.upsert({
              accountHash: account.accountHash,
              gmailMessageId: outcome.gmailMessageId,
              candidateIndex: 0,
              calendarEventId: plan.eventId,
              payloadHash: plan.provenance.payloadHash,
              etag: insertResult.event.etag ?? null,
              status: "applied",
              createdAt: ctx.clock.nowIso()
            });
            markActions(outcome.gmailMessageId, ["calendar_create"], "applied");
            calendarCreated += 1;
          } else if (insertResult.kind === "collision") {
            calendarLinksRepo.upsert({
              accountHash: account.accountHash,
              gmailMessageId: outcome.gmailMessageId,
              candidateIndex: 0,
              calendarEventId: plan.eventId,
              payloadHash: plan.provenance.payloadHash,
              etag: null,
              status: "failed",
              createdAt: ctx.clock.nowIso()
            });
            // A different app-owned event already holds this deterministic
            // ID with different provenance: needs human review, not a retry.
            markActions(outcome.gmailMessageId, ["calendar_create"], "failed_terminal", "calendar_id_collision");
            failureCount += 1;
          } else {
            // ambiguous_retry: the remote result genuinely cannot be known
            // from this response. Never guess; the same deterministic ID is
            // safe to retry on a later run.
            markActions(outcome.gmailMessageId, ["calendar_create"], "unknown_no_retry", "ambiguous_insert_result");
          }
        } catch {
          markActions(outcome.gmailMessageId, ["calendar_create"], "failed_retryable", "calendar_api_error");
          failureCount += 1;
        }
      }

      const finishedAt = ctx.clock.nowIso();
      runsRepo.finish(
        runId,
        failureCount > 0 ? "partial_failure" : "completed",
        finishedAt,
        {
          trashed: survivingTrash.length,
          labelMutations: labelResult.succeededMessageIds.length,
          calendarCreated,
          failures: failureCount
        },
        failureCount > 0 ? `${failureCount} action(s) failed; see the actions table for run ${runId}` : null
      );
    }

    const finalSummary = { ...summary, failureCount, scanNote };

    if (options.json) {
      console.log(
        JSON.stringify({ ...renderJsonSummary(finalSummary, { dryRun: options.dryRun }), runId: runId ?? null })
      );
    } else {
      console.log(renderHumanSummary(finalSummary, { dryRun: options.dryRun, ...(runId ? { runId } : {}) }));
    }
    return failureCount > 0 ? EXIT_CODES.operationalFailure : EXIT_CODES.ok;
  } finally {
    lock?.release();
  }
}
