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
  it("trashes an explicit spam rule match with no other actions", () => {
    const decision = evaluateMessagePolicy(
      baseInput({ explicitRule: { action: "spam", ruleGroupId: "g1" } })
    );
    expect(decision.actions).toEqual([{ type: "trash", reasonCode: "explicit_spam_rule" }]);
  });

  it("never trashes a protected message even with an explicit spam rule", () => {
    const decision = evaluateMessagePolicy(
      baseInput({ isProtected: true, explicitRule: { action: "spam", ruleGroupId: "g1" } })
    );
    expect(decision.actions.some((a) => a.type === "trash")).toBe(false);
    expect(decision.needsReview).toBe(true);
  });

  it("trashes unprotected native spam without needing an assessment", () => {
    const decision = evaluateMessagePolicy(baseInput({ isNativeSpam: true }));
    expect(decision.actions).toEqual([{ type: "trash", reasonCode: "native_spam" }]);
  });

  it("never trashes protected native spam", () => {
    const decision = evaluateMessagePolicy(baseInput({ isNativeSpam: true, isProtected: true }));
    expect(decision.actions.some((a) => a.type === "trash")).toBe(false);
    expect(decision.needsReview).toBe(true);
  });

  it("trashes a high-confidence AI promotion", () => {
    const decision = evaluateMessagePolicy(
      baseInput({ assessment: assessment({ kind: "promotion", confidence: 0.98 }) })
    );
    expect(decision.actions).toEqual([{ type: "trash", reasonCode: "ai_promotion" }]);
  });

  it("does not trash a promotion below the confidence threshold", () => {
    const decision = evaluateMessagePolicy(
      baseInput({ assessment: assessment({ kind: "promotion", confidence: 0.8 }) })
    );
    expect(decision.actions.some((a) => a.type === "trash")).toBe(false);
  });

  it("vetoes AI-derived trash when an authenticated high-risk signal is present", () => {
    const decision = evaluateMessagePolicy(
      baseInput({
        hasAuthenticatedHighRiskSignal: true,
        assessment: assessment({ kind: "promotion", confidence: 0.99 })
      })
    );
    expect(decision.actions.some((a) => a.type === "trash")).toBe(false);
    expect(decision.reviewReason).toBe("authenticated_high_risk_veto");
  });

  it("produces no AI-derived mutation when the assessment is unavailable, but still archives if read", () => {
    const decision = evaluateMessagePolicy(baseInput({ assessmentUnavailable: true }));
    expect(decision.actions).toEqual([{ type: "archive", reasonCode: "read_non_trash" }]);
    expect(decision.needsReview).toBe(true);
  });

  it("stars and marks important on qualifying importance scores", () => {
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
  });

  it("an explicit important rule stars regardless of AI availability", () => {
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
  });

  it("creates a calendar event on a high-confidence create intent", () => {
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
  });

  it("archives every read non-trash inbox message", () => {
    const decision = evaluateMessagePolicy(baseInput({ isRead: true, isInInbox: true }));
    expect(decision.actions).toContainEqual({ type: "archive", reasonCode: "read_non_trash" });
  });

  it("does not archive an unread message", () => {
    const decision = evaluateMessagePolicy(baseInput({ isRead: false }));
    expect(decision.actions.some((a) => a.type === "archive")).toBe(false);
  });

  it("never combines trash with any other action (invariant)", () => {
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
  });

  it("suspicious/unknown kinds never produce an AI-derived mutation", () => {
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
  });

  it("still creates a calendar event for a protected (already-Important) message (regression: protection must bypass importance classification, not event extraction)", () => {
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
  });

  it("still labels a protected message when the assessment carries a category", () => {
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
  });

  it("never trashes a protected message via AI assessment alone, even at high promotion confidence", () => {
    const decision = evaluateMessagePolicy(
      baseInput({ isProtected: true, assessment: assessment({ kind: "promotion", confidence: 0.99 }) })
    );
    expect(decision.actions.some((a) => a.type === "trash")).toBe(false);
  });

  it("does not double-star a protected message via AI importance (the explicit rule or existing label already covers it)", () => {
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
  });

  it("proposes a label action when the assessment carries a category", () => {
    const decision = evaluateMessagePolicy(
      baseInput({ assessment: assessment({ kind: "personal_routine", confidence: 0, category: "Shopping" }) })
    );
    expect(decision.actions).toContainEqual({
      type: "label",
      reasonCode: "ai_category:Shopping",
      labelName: "Shopping"
    });
  });

  it("does not propose a label action when category is null", () => {
    const decision = evaluateMessagePolicy(
      baseInput({ assessment: assessment({ kind: "personal_routine", confidence: 0, category: null }) })
    );
    expect(decision.actions.some((a) => a.type === "label")).toBe(false);
  });

  it("never labels a suspicious/unknown message even if category is somehow set", () => {
    const decision = evaluateMessagePolicy(
      baseInput({ isRead: false, assessment: assessment({ kind: "suspicious", category: "Shopping" }) })
    );
    expect(decision.actions.some((a) => a.type === "label")).toBe(false);
  });

  it("never labels a message that gets trashed (mutual exclusivity)", () => {
    const decision = evaluateMessagePolicy(baseInput({ isNativeSpam: true }));
    expect(decision.actions.some((a) => a.type === "label")).toBe(false);
  });

  it("uses the product-decided default thresholds (uniform 0.90)", () => {
    expect(DEFAULT_POLICY_THRESHOLDS).toEqual({
      autoTrashPromotionConfidence: 0.9,
      autoTrashAutomatedLowValueConfidence: 0.9,
      autoStarImportanceScore: 0.9,
      autoStarImportanceConfidence: 0.9,
      autoCreateEventConfidence: 0.9
    });
  });
});
