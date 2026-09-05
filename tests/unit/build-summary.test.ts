import { describe, expect, it } from "vitest";
import { buildRunSummary, type MessageOutcome } from "../../src/summary/build-summary.js";
import { renderHumanSummary } from "../../src/summary/render-human.js";
import type { PolicyDecision } from "../../src/core/policy.js";

function outcome(overrides: Partial<MessageOutcome> & { decision: PolicyDecision }): MessageOutcome {
  return {
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    subjectForDisplay: "Test subject",
    senderForDisplay: "sender@example.com",
    bypassReason: null,
    labelIdsAtSnapshot: [],
    validatedEvent: null,
    classifierVersion: null,
    internalDate: "1000",
    isUnread: false,
    ...overrides
  };
}

describe("buildRunSummary", () => {
  it("carries the exact subject/sender for every trashed message, not just a count", () => {
    const summary = buildRunSummary(5, [
      outcome({
        subjectForDisplay: "50% off everything!",
        senderForDisplay: "deals@shop.example.com",
        decision: { actions: [{ type: "trash", reasonCode: "ai_promotion" }], needsReview: false, reviewReason: null }
      })
    ]);
    expect(summary.trashed).toEqual([
      { subject: "50% off everything!", sender: "deals@shop.example.com", reasonCode: "ai_promotion" }
    ]);
    expect(summary.trashedByReason).toEqual({ ai_promotion: 1 });
  });

  it("carries details for archive/star/mark_important/calendar_create too", () => {
    const summary = buildRunSummary(1, [
      outcome({
        subjectForDisplay: "Dentist appointment",
        senderForDisplay: "clinic@example.com",
        decision: {
          actions: [
            { type: "star", reasonCode: "ai_importance_transactional_important" },
            { type: "mark_important", reasonCode: "ai_importance_transactional_important" },
            {
              type: "calendar_create",
              reasonCode: "ai_event_transactional_important",
              event: {
                intent: "create",
                confidence: 0.99,
                title: "Dentist",
                start: null,
                end: null,
                allDay: false,
                timeZone: null,
                location: null,
                sourceEvidence: null
              }
            },
            { type: "archive", reasonCode: "read_non_trash" }
          ],
          needsReview: false,
          reviewReason: null
        }
      })
    ]);
    expect(summary.starred).toHaveLength(1);
    expect(summary.markedImportant).toHaveLength(1);
    expect(summary.calendarCreated).toHaveLength(1);
    expect(summary.archived).toEqual([
      { subject: "Dentist appointment", sender: "clinic@example.com", reasonCode: "read_non_trash" }
    ]);
  });

  it("carries every Review item, not a capped sample", () => {
    const outcomes = Array.from({ length: 8 }, (_, i) =>
      outcome({
        subjectForDisplay: `Subject ${i}`,
        decision: { actions: [], needsReview: true, reviewReason: "assessment_unavailable" }
      })
    );
    const summary = buildRunSummary(8, outcomes);
    expect(summary.reviewSamples).toHaveLength(8);
  });

  it("lists unread messages under recentUnread, capped at 10, most-recent-first order preserved as given", () => {
    const outcomes = Array.from({ length: 12 }, (_, i) =>
      outcome({
        subjectForDisplay: `Unread ${i}`,
        isUnread: true,
        internalDate: String(12 - i),
        decision: { actions: [], needsReview: false, reviewReason: null }
      })
    );
    const summary = buildRunSummary(12, outcomes);
    expect(summary.recentUnread).toHaveLength(10);
    expect(summary.recentUnread[0]!.subject).toBe("Unread 0");
    expect(summary.recentUnread[9]!.subject).toBe("Unread 9");
  });

  it("does not list a read message under recentUnread", () => {
    const summary = buildRunSummary(1, [
      outcome({
        subjectForDisplay: "Read message",
        isUnread: false,
        decision: { actions: [], needsReview: false, reviewReason: null }
      })
    ]);
    expect(summary.recentUnread).toEqual([]);
  });

  it("lists a message with no action and no review flag under unchanged, uncapped", () => {
    const outcomes = Array.from({ length: 15 }, (_, i) =>
      outcome({
        subjectForDisplay: `Unchanged ${i}`,
        decision: { actions: [], needsReview: false, reviewReason: null }
      })
    );
    const summary = buildRunSummary(15, outcomes);
    expect(summary.unchanged).toHaveLength(15);
  });

  it("does not double-list a message under unchanged when it has an action or needs review", () => {
    const summary = buildRunSummary(2, [
      outcome({
        subjectForDisplay: "Archived",
        decision: { actions: [{ type: "archive", reasonCode: "read_non_trash" }], needsReview: false, reviewReason: null }
      }),
      outcome({
        subjectForDisplay: "Needs review",
        decision: { actions: [], needsReview: true, reviewReason: "assessment_unavailable" }
      })
    ]);
    expect(summary.unchanged).toEqual([]);
  });
});

describe("renderHumanSummary", () => {
  it("prints the exact subject line for a trashed message", () => {
    const summary = buildRunSummary(1, [
      outcome({
        subjectForDisplay: "Win a free prize now",
        senderForDisplay: "spam@example.com",
        decision: { actions: [{ type: "trash", reasonCode: "native_spam" }], needsReview: false, reviewReason: null }
      })
    ]);
    const text = renderHumanSummary(summary, { dryRun: true });
    expect(text).toContain("Win a free prize now");
    expect(text).toContain("spam@example.com");
  });
});
