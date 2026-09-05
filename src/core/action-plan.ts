import { deterministicActionKey, payloadHash } from "./ids.js";
import type { ActionType, PlannedAction } from "./models.js";
import type { PolicyActionIntent } from "./policy.js";

export interface BuildActionInput {
  runId: string;
  accountHash: string;
  gmailMessageId: string;
  gmailThreadId: string;
  beforeStateHash: string | null;
  nowIso: string;
}

const ACTION_TYPE_BY_INTENT: Record<PolicyActionIntent["type"], ActionType> = {
  trash: "trash",
  star: "star",
  mark_important: "mark_important",
  archive: "archive",
  calendar_create: "calendar_create",
  label: "label"
};

/** Turns policy intents into durable, deterministically-keyed planned actions. */
export function buildPlannedActions(
  intents: readonly PolicyActionIntent[],
  input: BuildActionInput
): PlannedAction[] {
  return intents.map((intent) => {
    const type = ACTION_TYPE_BY_INTENT[intent.type];
    const payload =
      intent.type === "calendar_create"
        ? { reasonCode: intent.reasonCode, event: intent.event }
        : intent.type === "label"
          ? { reasonCode: intent.reasonCode, labelName: intent.labelName }
          : { reasonCode: intent.reasonCode };
    const hash = payloadHash(payload);
    return {
      actionKey: deterministicActionKey({
        accountHash: input.accountHash,
        type,
        target: input.gmailMessageId,
        payloadHash: hash
      }),
      runId: input.runId,
      accountHash: input.accountHash,
      type,
      targetGmailMessageId: input.gmailMessageId,
      targetGmailThreadId: input.gmailThreadId,
      targetCalendarEventId: null,
      reasonCode: intent.reasonCode,
      beforeStateHash: input.beforeStateHash,
      payloadHash: hash,
      status: "planned",
      attemptCount: 0,
      errorClass: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso
    };
  });
}
