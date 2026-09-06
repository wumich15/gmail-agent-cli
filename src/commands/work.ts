import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { runWorkScan } from "../core/orchestrator.js";
import { resolveClassifier } from "../ai/resolve-classifier.js";
import { RuleGroupsRepository } from "../state/repositories/rule-groups.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
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
  labelOnlyMutation,
  markImportantOnlyMutation,
  starOnlyMutation,
  trashMessage
} from "../gmail/executor.js";
import { getOrCreateLabelId, listUserLabels } from "../gmail/custom-labels.js";
import { LabelCandidatesRepository } from "../state/repositories/label-candidates.js";
import { buildEventInsertPlan, insertIdempotentEvent } from "../calendar/idempotency.js";
import { withGoogleApiRetry } from "../core/api-retry.js";
import { contentHash } from "../core/ids.js";
import type { PolicyActionIntent } from "../core/policy.js";
import type { ActionType, PlannedAction } from "../core/models.js";

export interface WorkOptions {
  dryRun: boolean;
  json: boolean;
  /** Caps the Inbox and native-Spam scans to this many most-recent messages each, to bound Gmail API quota usage. */
  limit?: number;
}

/** `labelIdByName` must already hold an entry for every label action's name (lowercased) before this is called. */
function mutationForActions(actions: readonly PolicyActionIntent[], labelIdByName: ReadonlyMap<string, string>) {
  const mutations = actions
    .filter(
      (a): a is Extract<PolicyActionIntent, { type: "star" | "mark_important" | "archive" | "label" }> =>
        a.type === "star" || a.type === "mark_important" || a.type === "archive" || a.type === "label"
    )
    .map((a) => {
      if (a.type === "star") return starOnlyMutation();
      if (a.type === "mark_important") return markImportantOnlyMutation();
      if (a.type === "archive") return archiveMutation();
      const labelId = labelIdByName.get(a.labelName.trim().toLowerCase());
      // Should always be present — the caller resolves every needed label
      // before building mutations — but a message simply keeps whatever
      // its other actions already do rather than throwing if not.
      return labelId ? labelOnlyMutation(labelId) : { addLabelIds: [], removeLabelIds: [] };
    });
  return combineMutations(mutations);
}

export async function runWork(options: WorkOptions): Promise<number> {
  const ctx = bootstrap();
  const { account, gmailClient, calendarClient } = await resolveAccountSigningInIfNeeded(ctx);

  const { classifier, description } = await resolveClassifier({
    accountHash: account.accountHash,
    credentialStore: ctx.credentialStore,
    config: ctx.config
  });
  // Always goes to stderr, even in --json mode: it never touches stdout,
  // so it can't corrupt a piped JSON summary, and this is important
  // enough to not hide from a human who happens to be running --json.
  console.error(pc.dim(description));

  const lock = options.dryRun ? null : new ProcessLock(lockFilePath(account.accountHash));
  lock?.acquire();

  try {
    const ruleGroups = new RuleGroupsRepository(ctx.db).listEnabled(account.accountHash);

    // Reading the label list is safe even in --dry-run (no mutation); it's
    // what lets the classifier prefer reusing an existing label over
    // inventing a near-duplicate. `labelIdByName` seeds label resolution
    // below for any label actions that survive the run's threshold check.
    const existingLabels = await listUserLabels(gmailClient);
    const labelIdByName = new Map(existingLabels.map((l) => [l.name.trim().toLowerCase(), l.id]));

    const labelCandidatesRepo = new LabelCandidatesRepository(ctx.db);
    const priorLabelCandidateCounts = new Map(
      labelCandidatesRepo
        .listForAccount(account.accountHash)
        .map((c) => [c.normalizedName, { displayName: c.displayName, count: c.pendingCount }] as const)
    );

    const {
      summary,
      outcomes,
      scanNote,
      newHistoryMarker,
      usedIncrementalSync,
      labelCandidateUpdates
    } = await runWorkScan({
      gmailClient,
      classifier,
      ruleGroups,
      userEmail: account.emailDisplay ?? "",
      userTimezone: account.timezone,
      clock: ctx.clock,
      concurrency: { gmailReads: 5, aiCalls: ctx.config?.concurrency.aiCalls ?? 5 },
      existingLabels: existingLabels.map((l) => l.name),
      priorLabelCandidateCounts,
      // Incremental sync against Gmail's history API is the main lever for
      // staying under Gmail's API quota on repeat runs — see
      // CLAUDE.md's "Incremental synchronization". Passing null/omitting
      // forces a full snapshot (this account's first-ever run).
      historyMarker: account.historyMarker,
      ...(options.limit !== undefined ? { limit: options.limit } : {})
    });
    // Always goes to stderr for the same reason as the classifier
    // description above: informational, never part of a piped --json summary.
    console.error(
      pc.dim(usedIncrementalSync ? "Incremental scan (via Gmail history)." : "Full inbox/spam snapshot scan.")
    );

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
      const nonTrashOutcomes: typeof outcomes = [];
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
          nonTrashOutcomes.push(outcome);
        }
      }

      // Resolve every label name this run actually needs to a real Gmail
      // label ID, creating new ones only now that a real (non-dry-run) run
      // is committed to acting. A name that fails to resolve (e.g. a
      // transient Gmail error creating it) is simply left out of every
      // mutation that needed it below, rather than failing the whole run.
      const neededLabelNames = new Set<string>();
      for (const outcome of nonTrashOutcomes) {
        for (const action of outcome.decision.actions) {
          if (action.type === "label") neededLabelNames.add(action.labelName);
        }
      }
      for (const name of neededLabelNames) {
        if (!labelIdByName.has(name.trim().toLowerCase())) {
          try {
            await getOrCreateLabelId(gmailClient, name, labelIdByName);
          } catch {
            // Left unresolved; mutationForActions below omits it for this run.
          }
        }
      }

      const labelTargets: { messageId: string; mutation: ReturnType<typeof mutationForActions> }[] = [];
      for (const outcome of nonTrashOutcomes) {
        const mutation = mutationForActions(outcome.decision.actions, labelIdByName);
        if (mutation.addLabelIds.length > 0 || mutation.removeLabelIds.length > 0) {
          labelTargets.push({ messageId: outcome.gmailMessageId, mutation });
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
        markActions(messageId, ["star", "mark_important", "archive", "label"], "applying");
      }
      const labelResult = await applyGroupedLabelMutations(gmailClient, labelTargets);
      for (const messageId of labelResult.succeededMessageIds) {
        markActions(messageId, ["star", "mark_important", "archive", "label"], "applied");
      }
      for (const messageId of labelResult.failedMessageIds) {
        markActions(messageId, ["star", "mark_important", "archive", "label"], "failed_retryable", "gmail_api_error");
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

      // Only advance the marker now that the run's plan/ledger is durable
      // (CLAUDE.md: "Advance Gmail history only after the ingestion/plan
      // checkpoint is durable"). A failed individual action still stays in
      // the ledger for later reconciliation regardless of this — advancing
      // history only changes which messages a *future* scan looks at.
      new AccountsRepository(ctx.db).updateHistoryMarker(account.accountHash, newHistoryMarker, finishedAt);

      // Persist each category's updated cumulative count: cleared once it
      // actually crossed the threshold and got applied this run (from then
      // on the label exists, so `existingLabels` alone keeps applying it —
      // see applyLabelBatchThreshold), otherwise the new running total so
      // occurrences keep accumulating across incremental-sync runs instead
      // of resetting every time.
      for (const update of labelCandidateUpdates) {
        if (update.applied) {
          labelCandidatesRepo.clear(account.accountHash, update.normalizedName);
        } else {
          labelCandidatesRepo.upsert({
            accountHash: account.accountHash,
            normalizedName: update.normalizedName,
            displayName: update.displayName,
            pendingCount: update.newCumulativeCount,
            updatedAt: finishedAt
          });
        }
      }
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
