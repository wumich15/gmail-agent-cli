import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount } from "./shared.js";
import { RunsRepository, ActionsRepository } from "../state/repositories/runs.js";
import { EXIT_CODES } from "../core/errors.js";
import {
  apiErrorStatus,
  isRetryableGoogleQuotaMessage,
  isRetryableStatus,
  withGoogleApiRetry
} from "../core/api-retry.js";

export async function runSummary(runId: string | undefined, options: { json: boolean }): Promise<number> {
  const ctx = bootstrap();
  const { account, gmailClient } = await resolveAccount(ctx);
  const runsRepo = new RunsRepository(ctx.db);
  const actionsRepo = new ActionsRepository(ctx.db);

  const run = runId ? runsRepo.get(runId) : runsRepo.listRecent(account.accountHash, 1)[0];
  if (!run) {
    console.error(pc.red(runId ? `No run with ID ${runId}.` : "No runs recorded yet."));
    return EXIT_CODES.invalidOrAuthRequired;
  }

  const actions = actionsRepo.listForRun(run.runId);
  const byType: Record<string, number> = {};
  for (const action of actions) {
    byType[action.type] = (byType[action.type] ?? 0) + 1;
  }

  if (options.json) {
    // Every action from the run, not just aggregate counts — the durable
    // ledger is the full audit trail, and nothing here is truncated.
    console.log(JSON.stringify({ run, actionCountsByType: byType, actions }));
    return EXIT_CODES.ok;
  }

  console.log(pc.bold(`Run ${run.runId} (${run.mode}) — ${run.status}`));
  console.log(`Started: ${run.startedAt}${run.finishedAt ? `  Finished: ${run.finishedAt}` : ""}`);
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }

  console.log(
    pc.dim(
      `Reconstructed from the durable action ledger (${actions.length} action(s), all listed below); ` +
        "cannot reproduce transient AI text exactly."
    )
  );

  for (const action of actions) {
    if (!action.targetGmailMessageId) continue;
    try {
      const { data } = await withGoogleApiRetry(() =>
        gmailClient.users.messages.get({
          userId: "me",
          id: action.targetGmailMessageId!,
          format: "metadata",
          metadataHeaders: ["From", "Subject"]
        })
      );
      const headers = data.payload?.headers ?? [];
      const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
      const from = headers.find((h) => h.name === "From")?.value ?? "unknown";
      console.log(`  · [${action.type}/${action.status}] ${subject} — ${from}`);
    } catch (error) {
      // A quota/rate-limit failure surviving the retry budget is not the
      // same as the message being gone — conflating them here would mask a
      // real Gmail API problem as ordinary data loss.
      if (isRetryableStatus(apiErrorStatus(error)) || isRetryableGoogleQuotaMessage(error)) {
        console.log(`  · [${action.type}/${action.status}] message ${action.targetGmailMessageId} (Gmail API rate-limited — try again later)`);
      } else {
        console.log(`  · [${action.type}/${action.status}] message ${action.targetGmailMessageId} (no longer accessible)`);
      }
    }
  }

  return EXIT_CODES.ok;
}
