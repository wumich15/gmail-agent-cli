import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount } from "./shared.js";
import { runWorkScan } from "../core/orchestrator.js";
import { NotConfiguredClassifier } from "../ai/not-configured-classifier.js";
import { RuleGroupsRepository } from "../state/repositories/rule-groups.js";
import { RunsRepository, ActionsRepository } from "../state/repositories/runs.js";
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
import { contentHash } from "../core/ids.js";
import type { PolicyActionIntent } from "../core/policy.js";

export interface WorkOptions {
  dryRun: boolean;
  json: boolean;
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

export async function runWork(options: WorkOptions): Promise<number> {
  const ctx = bootstrap();
  const { account, gmailClient } = await resolveAccount(ctx);

  const lock = options.dryRun ? null : new ProcessLock(lockFilePath());
  lock?.acquire();

  try {
    const ruleGroups = new RuleGroupsRepository(ctx.db).listEnabled(account.accountHash);

    const { summary, outcomes } = await runWorkScan({
      gmailClient,
      classifier: new NotConfiguredClassifier(),
      ruleGroups,
      userEmail: account.emailDisplay ?? "",
      clock: ctx.clock,
      concurrency: { gmailReads: 5 }
    });

    if (!options.dryRun) {
      const runId = newRunId();
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

      // Immediately before mutating, re-fetch current label state so a
      // change the user made after the snapshot (e.g. starring a message)
      // is respected rather than overwritten.
      const survivingTrash: string[] = [];
      for (const messageId of trashTargets) {
        const { data } = await gmailClient.users.messages.get({
          userId: "me",
          id: messageId,
          format: "minimal"
        });
        const labels = data.labelIds ?? [];
        if (labels.includes("STARRED") || labels.includes("IMPORTANT")) {
          continue; // user protected it after the snapshot; skip this trash.
        }
        survivingTrash.push(messageId);
      }

      for (const messageId of survivingTrash) {
        await trashMessage(gmailClient, messageId);
      }
      await applyGroupedLabelMutations(gmailClient, labelTargets);

      const finishedAt = ctx.clock.nowIso();
      runsRepo.finish(runId, "completed", finishedAt, {
        trashed: survivingTrash.length,
        labelMutations: labelTargets.length
      }, null);
    }

    if (options.json) {
      console.log(JSON.stringify(renderJsonSummary(summary, { dryRun: options.dryRun })));
    } else {
      console.log(renderHumanSummary(summary, { dryRun: options.dryRun }));
    }
    return EXIT_CODES.ok;
  } finally {
    lock?.release();
  }
}
