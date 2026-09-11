import { runScenarios } from "../helpers/scenarios.js";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY_THRESHOLDS,
  evaluateMessagePolicy,
  type MessagePolicyInput
} from "../../src/core/policy.js";
import type { EmailAssessment } from "../../src/core/models.js";

function baseInput(overrides: Partial<MessagePolicyInput> = {}): MessagePolicyInput {
  return {
    gmailMessageId: "msg-1",
    isInInbox: true,
    isRead: true,
    isNativeSpam: false,
    isProtected: false,
    explicitRule: null,
    hasAuthenticatedHighRiskSignal: false,
    assessment: null,
    assessmentUnavailable: false,
    ...overrides
  };
}

function assessment(overrides: Partial<EmailAssessment> = {}): EmailAssessment {
  return {
    kind: "promotion",
    confidence: 0.99,
    importanceScore: 0.1,
    importanceConfidence: 0.1,
    summary: "test",
    reasonCodes: ["marketing_content"],
    event: {
      intent: "none",
      confidence: 0,
      title: null,
      start: null,
      end: null,
      allDay: false,
      timeZone: null,
      location: null,
      sourceEvidence: null
    },
    category: null,
    classifierVersion: "test",
    promptVersion: "test",
    schemaVersion: "test",
    ...overrides
  };
}

describe("evaluateMessagePolicy", () => {
  it("preserves all 25 scenarios", async () => {
    await runScenarios([
      { name: "trashes an explicit spam rule match with no other actions", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({ explicitRule: { action: "spam", ruleGroupId: "g1" } })
    );
    expect(decision.actions).toEqual([{ type: "trash", reasonCode: "explicit_spam_rule" }]);
  } },
      { name: "never trashes a protected message even with an explicit spam rule", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({ isProtected: true, explicitRule: { action: "spam", ruleGroupId: "g1" } })
    );
    expect(decision.actions.some((a) => a.type === "trash")).toBe(false);
    expect(decision.needsReview).toBe(true);
  } },
      { name: "trashes unprotected native spam without needing an assessment", run: () => {
    const decision = evaluateMessagePolicy(baseInput({ isNativeSpam: true }));
    expect(decision.actions).toEqual([{ type: "trash", reasonCode: "native_spam" }]);
  } },
      { name: "never trashes protected native spam", run: () => {
    const decision = evaluateMessagePolicy(baseInput({ isNativeSpam: true, isProtected: true }));
    expect(decision.actions.some((a) => a.type === "trash")).toBe(false);
    expect(decision.needsReview).toBe(true);
  } },
      { name: "trashes a high-confidence AI promotion", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({ assessment: assessment({ kind: "promotion", confidence: 0.98 }) })
    );
    expect(decision.actions).toEqual([{ type: "trash", reasonCode: "ai_promotion" }]);
  } },
      { name: "does not trash a promotion below the confidence threshold", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({ assessment: assessment({ kind: "promotion", confidence: 0.8 }) })
    );
    expect(decision.actions.some((a) => a.type === "trash")).toBe(false);
  } },
      { name: "vetoes AI-derived trash when an authenticated high-risk signal is present", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({
        hasAuthenticatedHighRiskSignal: true,
        assessment: assessment({ kind: "promotion", confidence: 0.99 })
      })
    );
    expect(decision.actions.some((a) => a.type === "trash")).toBe(false);
    expect(decision.reviewReason).toBe("authenticated_high_risk_veto");
  } },
      { name: "produces no AI-derived mutation when the assessment is unavailable, but still archives if read and asked to", run: () => {
    const decision = evaluateMessagePolicy(baseInput({ assessmentUnavailable: true, archiveReadMail: true }));
    expect(decision.actions).toEqual([{ type: "archive", reasonCode: "read_non_trash" }]);
    expect(decision.needsReview).toBe(true);
  } },
      { name: "leaves read mail in the Inbox unless archiving was asked for", run: () => {
    // Archiving is the one cleanup action with no obvious trace — the mail is
    // in neither the Inbox nor the Trash — so it only happens on request.
    const decision = evaluateMessagePolicy(baseInput({ isRead: true, isInInbox: true }));
    expect(decision.actions.some((a) => a.type === "archive")).toBe(false);
  } },
      { name: "stars and marks important on qualifying importance scores", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({
        assessment: assessment({
          kind: "personal_important",
          confidence: 0.9,
          importanceScore: 0.9,
          importanceConfidence: 0.95
        })
      })
    );
    expect(decision.actions).toContainEqual({
      type: "star",
      reasonCode: "ai_importance_personal_important"
    });
    expect(decision.actions).toContainEqual({
      type: "mark_important",
      reasonCode: "ai_importance_personal_important"
    });
  } },
      { name: "an explicit important rule stars regardless of AI availability", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({ explicitRule: { action: "important", ruleGroupId: "g1" } })
    );
    expect(decision.actions).toContainEqual({
      type: "star",
      reasonCode: "explicit_important_rule"
    });
    expect(decision.actions).toContainEqual({
      type: "mark_important",
      reasonCode: "explicit_important_rule"
    });
  } },
      { name: "creates a calendar event on a high-confidence create intent", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({
        assessment: assessment({
          kind: "transactional_important",
          event: {
            intent: "create",
            confidence: 0.97,
            title: "Dentist",
            start: "2099-01-01T10:00:00Z",
            end: "2099-01-01T11:00:00Z",
            allDay: false,
            timeZone: "UTC",
            location: null,
            sourceEvidence: "see you at 10am"
          }
        })
      })
    );
    expect(decision.actions.some((a) => a.type === "calendar_create")).toBe(true);
  } },
      { name: "archives every read non-trash inbox message when archiving is requested", run: () => {
    const decision = evaluateMessagePolicy(baseInput({ isRead: true, isInInbox: true, archiveReadMail: true }));
    expect(decision.actions).toContainEqual({ type: "archive", reasonCode: "read_non_trash" });
  } },
      { name: "does not archive an unread message even when archiving is requested", run: () => {
    const decision = evaluateMessagePolicy(baseInput({ isRead: false, archiveReadMail: true }));
    expect(decision.actions.some((a) => a.type === "archive")).toBe(false);
  } },
      { name: "never combines trash with any other action (invariant)", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({
        isNativeSpam: true,
        assessment: assessment({
          importanceScore: 0.99,
          importanceConfidence: 0.99,
          event: { ...assessment().event, intent: "create", confidence: 0.99 }
        })
      })
    );
    if (decision.actions.some((a) => a.type === "trash")) {
      expect(decision.actions).toHaveLength(1);
    }
  } },
      { name: "suspicious/unknown kinds never produce an AI-derived mutation", run: () => {
    for (const kind of ["suspicious", "unknown"] as const) {
      const decision = evaluateMessagePolicy(
        baseInput({
          isRead: false,
          assessment: assessment({
            kind,
            importanceScore: 0.99,
            importanceConfidence: 0.99
          })
        })
      );
      expect(decision.actions).toEqual([]);
      expect(decision.needsReview).toBe(true);
    }
  } },
      { name: "still creates a calendar event for a protected (already-Important) message (regression: protection must bypass importance classification, not event extraction)", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({
        isProtected: true,
        assessment: assessment({
          kind: "transactional_important",
          confidence: 0,
          event: {
            intent: "create",
            confidence: 0.97,
            title: "Dentist",
            start: "2099-01-01T10:00:00Z",
            end: "2099-01-01T11:00:00Z",
            allDay: false,
            timeZone: "UTC",
            location: null,
            sourceEvidence: "see you at 10am"
          }
        })
      })
    );
    expect(decision.actions.some((a) => a.type === "calendar_create")).toBe(true);
  } },
      { name: "still labels a protected message when the assessment carries a category", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({
        isProtected: true,
        assessment: assessment({ kind: "personal_routine", confidence: 0, category: "Receipts" })
      })
    );
    expect(decision.actions).toContainEqual({
      type: "label",
      reasonCode: "ai_category:Receipts",
      labelName: "Receipts"
    });
  } },
      { name: "never trashes a protected message via AI assessment alone, even at high promotion confidence", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({ isProtected: true, assessment: assessment({ kind: "promotion", confidence: 0.99 }) })
    );
    expect(decision.actions.some((a) => a.type === "trash")).toBe(false);
  } },
      { name: "does not double-star a protected message via AI importance (the explicit rule or existing label already covers it)", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({
        isProtected: true,
        assessment: assessment({
          kind: "personal_important",
          confidence: 0,
          importanceScore: 0.99,
          importanceConfidence: 0.99
        })
      })
    );
    expect(decision.actions.some((a) => a.type === "star")).toBe(false);
  } },
      { name: "proposes a label action when the assessment carries a category", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({ assessment: assessment({ kind: "personal_routine", confidence: 0, category: "Shopping" }) })
    );
    expect(decision.actions).toContainEqual({
      type: "label",
      reasonCode: "ai_category:Shopping",
      labelName: "Shopping"
    });
  } },
      { name: "does not propose a label action when category is null", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({ assessment: assessment({ kind: "personal_routine", confidence: 0, category: null }) })
    );
    expect(decision.actions.some((a) => a.type === "label")).toBe(false);
  } },
      { name: "never labels a suspicious/unknown message even if category is somehow set", run: () => {
    const decision = evaluateMessagePolicy(
      baseInput({ isRead: false, assessment: assessment({ kind: "suspicious", category: "Shopping" }) })
    );
    expect(decision.actions.some((a) => a.type === "label")).toBe(false);
  } },
      { name: "never labels a message that gets trashed (mutual exclusivity)", run: () => {
    const decision = evaluateMessagePolicy(baseInput({ isNativeSpam: true }));
    expect(decision.actions.some((a) => a.type === "label")).toBe(false);
  } },
      { name: "uses the product-decided default thresholds (uniform 0.90)", run: () => {
    expect(DEFAULT_POLICY_THRESHOLDS).toEqual({
      autoTrashPromotionConfidence: 0.9,
      autoTrashAutomatedLowValueConfidence: 0.9,
      autoStarImportanceScore: 0.9,
      autoStarImportanceConfidence: 0.9,
      autoCreateEventConfidence: 0.9
    });
  } }
    ]);
  });
});
