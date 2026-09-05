import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount } from "./shared.js";
import { RunsRepository, ActionsRepository } from "../state/repositories/runs.js";
import { EXIT_CODES } from "../core/errors.js";
import { GMAIL_LABELS } from "../gmail/labels.js";

export async function runUndo(runId: string, options: { yes: boolean }): Promise<number> {
  const ctx = bootstrap();
  const { gmailClient } = await resolveAccount(ctx);
  const runsRepo = new RunsRepository(ctx.db);
  const actionsRepo = new ActionsRepository(ctx.db);

  const run = runsRepo.get(runId);
  if (!run) {
    console.error(pc.red(`No run with ID ${runId}.`));
    return EXIT_CODES.invalidOrAuthRequired;
  }

  const actions = actionsRepo.listForRun(runId).filter((a) => a.status === "applied");
  const reversible = actions.filter((a) => a.type !== "unsubscribe");
  const unsubscribeCount = actions.length - reversible.length;

  console.log(`Run ${runId}: ${reversible.length} reversible action(s) to undo.`);
  if (unsubscribeCount > 0) {
    console.log(pc.yellow(`${unsubscribeCount} unsubscribe action(s) cannot be reversed and will be skipped.`));
  }

  if (!options.yes) {
    const confirmed = await p.confirm({ message: `Undo ${reversible.length} action(s) from run ${runId}?` });
    if (p.isCancel(confirmed) || !confirmed) {
      console.log("Cancelled.");
      return EXIT_CODES.safetyBlocked;
    }
  }

  let undone = 0;
  let skipped = 0;
  const nowIso = ctx.clock.nowIso();

  for (const action of reversible) {
    if (!action.targetGmailMessageId) continue;
    try {
      const { data } = await gmailClient.users.messages.get({
        userId: "me",
        id: action.targetGmailMessageId,
        format: "minimal"
      });
      const currentLabels = data.labelIds ?? [];

      switch (action.type) {
        case "trash":
          await gmailClient.users.messages.untrash({ userId: "me", id: action.targetGmailMessageId });
          undone += 1;
          break;
        case "archive":
          if (currentLabels.includes(GMAIL_LABELS.inbox)) {
            skipped += 1; // user already has it back in Inbox or re-archived differently; nothing to do.
          } else {
            await gmailClient.users.messages.modify({
              userId: "me",
              id: action.targetGmailMessageId,
              requestBody: { addLabelIds: [GMAIL_LABELS.inbox] }
            });
            undone += 1;
          }
          break;
        case "star":
          await gmailClient.users.messages.modify({
            userId: "me",
            id: action.targetGmailMessageId,
            requestBody: { removeLabelIds: [GMAIL_LABELS.starred] }
          });
          undone += 1;
          break;
        case "mark_important":
          await gmailClient.users.messages.modify({
            userId: "me",
            id: action.targetGmailMessageId,
            requestBody: { removeLabelIds: [GMAIL_LABELS.important] }
          });
          undone += 1;
          break;
        default:
          skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  runsRepo.finish(runId, run.status, run.finishedAt ?? nowIso, { ...run.counters, undone }, run.errorSummary);

  console.log(`Undone: ${undone}. Skipped (conflict or not applicable): ${skipped}.`);
  return EXIT_CODES.ok;
}
