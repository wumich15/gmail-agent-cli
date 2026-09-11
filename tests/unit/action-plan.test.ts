import { describe, expect, it } from "vitest";
import { buildPlannedActions } from "../../src/core/action-plan.js";
import { actionsAfterCalendarOutcome, outcomesAsApplied } from "../../src/commands/work.js";
import { buildRunSummary, type MessageOutcome } from "../../src/summary/build-summary.js";
import type { PolicyActionIntent } from "../../src/core/policy.js";
import type { EventCandidate } from "../../src/core/models.js";

const EVENT: EventCandidate = {
  intent: "create",
  confidence: 0.95,
  title: "Dental cleaning",
  start: "2030-01-02T14:00:00.000Z",
  end: "2030-01-02T15:00:00.000Z",
  allDay: false,
  timeZone: "UTC",
  location: null,
  sourceEvidence: "Thursday at 2pm"
};

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

describe("actionsAfterCalendarOutcome", () => {
  const calendarLabel = { type: "label" as const, reasonCode: "calendar_label:Calendar", labelName: "Calendar" };
  const calendarArchive = { type: "archive" as const, reasonCode: "calendar_archive" };
  const readArchive = { type: "archive" as const, reasonCode: "read_non_trash" };
  const star = { type: "star" as const, reasonCode: "ai_importance_transactional_important" };

  it("keeps the Calendar label and archive when the event really was created", () => {
    const actions = [calendarLabel, calendarArchive, star];
    expect(actionsAfterCalendarOutcome(actions, true)).toEqual(actions);
  });

  it("withdraws both when the event was not created, so the mail is not filed away as if it exists", () => {
    // The label and the out-of-Inbox archive are the user's only signal that
    // the commitment is recorded on their calendar. Applying them after a
    // failed insert loses the appointment silently.
    expect(actionsAfterCalendarOutcome([calendarLabel, calendarArchive, star], false)).toEqual([star]);
  });

  it("still archives a read message, whose archive was never the Calendar's doing", () => {
    expect(actionsAfterCalendarOutcome([calendarLabel, readArchive], false)).toEqual([readArchive]);
  });
});

describe("outcomesAsApplied", () => {
  const outcome = (id: string, actions: PolicyActionIntent[]): MessageOutcome => ({
    gmailMessageId: id,
    gmailThreadId: `t-${id}`,
    subjectForDisplay: `Subject ${id}`,
    senderForDisplay: "sender@example.com",
    decision: { actions, needsReview: false, reviewReason: null },
    bypassReason: null,
    labelIdsAtSnapshot: ["INBOX"],
    validatedEvent: null,
    classifierVersion: "openai:test",
    internalDate: "1000",
    isUnread: true
  });
  const empty = {
    trashedMessageIds: new Set<string>(),
    labelMutatedMessageIds: new Set<string>(),
    calendarCreatedMessageIds: new Set<string>(),
    calendarFailedMessageIds: new Set<string>()
  };

  it("drops a trash Gmail refused, so the summary cannot claim mail was removed that is still there", () => {
    const outcomes = [outcome("kept", [{ type: "trash", reasonCode: "ai_promotion" }])];
    const applied = outcomesAsApplied(outcomes, empty);
    expect(applied[0]!.decision.actions).toEqual([]);
    expect(buildRunSummary(10, applied).trashed).toEqual([]);
  });

  it("keeps the actions that succeeded and reports them", () => {
    const outcomes = [
      outcome("gone", [{ type: "trash", reasonCode: "native_spam" }]),
      outcome("filed", [{ type: "archive", reasonCode: "read_non_trash" }])
    ];
    const applied = outcomesAsApplied(outcomes, {
      ...empty,
      trashedMessageIds: new Set(["gone"]),
      labelMutatedMessageIds: new Set(["filed"])
    });
    const summary = buildRunSummary(10, applied);
    expect(summary.trashed).toHaveLength(1);
    expect(summary.archivedCount).toBe(1);
  });

  it("reports neither the event nor its label when the Calendar insert failed", () => {
    const outcomes = [
      outcome("meeting", [
        { type: "calendar_create", reasonCode: "ai_event_transactional_important", event: EVENT },
        { type: "label", reasonCode: "calendar_label:Calendar", labelName: "Calendar" },
        { type: "archive", reasonCode: "calendar_archive" }
      ])
    ];
    const applied = outcomesAsApplied(outcomes, {
      ...empty,
      labelMutatedMessageIds: new Set(["meeting"]),
      calendarFailedMessageIds: new Set(["meeting"])
    });
    expect(applied[0]!.decision.actions).toEqual([]);
    const summary = buildRunSummary(10, applied);
    expect(summary.calendarCreatedCount).toBe(0);
    expect(summary.labeled).toEqual([]);
    expect(summary.archivedCount).toBe(0);
  });
});
