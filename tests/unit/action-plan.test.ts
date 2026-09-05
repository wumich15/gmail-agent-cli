import { describe, expect, it } from "vitest";
import { buildPlannedActions } from "../../src/core/action-plan.js";

const BASE_INPUT = {
  runId: "run-1",
  accountHash: "acct-1",
  gmailMessageId: "m1",
  gmailThreadId: "t1",
  beforeStateHash: "hash-1",
  nowIso: "2025-01-01T00:00:00.000Z"
};

describe("buildPlannedActions", () => {
  it("maps a label intent to a 'label' planned action carrying the label name in its payload hash", () => {
    const [action] = buildPlannedActions(
      [{ type: "label", reasonCode: "ai_category:Shopping", labelName: "Shopping" }],
      BASE_INPUT
    );
    expect(action!.type).toBe("label");
    expect(action!.reasonCode).toBe("ai_category:Shopping");
  });

  it("gives two different label names on the same message two distinct deterministic action keys", () => {
    const [shopping] = buildPlannedActions(
      [{ type: "label", reasonCode: "ai_category:Shopping", labelName: "Shopping" }],
      BASE_INPUT
    );
    const [calendar] = buildPlannedActions(
      [{ type: "label", reasonCode: "calendar_label:Calendar", labelName: "Calendar" }],
      BASE_INPUT
    );
    expect(shopping!.actionKey).not.toBe(calendar!.actionKey);
  });

  it("gives the same label intent the same deterministic action key across calls (idempotent replay)", () => {
    const intent = { type: "label" as const, reasonCode: "ai_category:Shopping", labelName: "Shopping" };
    const [first] = buildPlannedActions([intent], BASE_INPUT);
    const [second] = buildPlannedActions([intent], { ...BASE_INPUT, nowIso: "2025-02-02T00:00:00.000Z" });
    expect(first!.actionKey).toBe(second!.actionKey);
  });
});
