import type { EmailAssessment, EventCandidate, RuleAction } from "./models.js";

export const POLICY_VERSION = "policy-v1";

export interface PolicyThresholds {
  autoTrashPromotionConfidence: number;
  autoTrashAutomatedLowValueConfidence: number;
  autoStarImportanceScore: number;
  autoStarImportanceConfidence: number;
  autoCreateEventConfidence: number;
}

export const DEFAULT_POLICY_THRESHOLDS: PolicyThresholds = {
  autoTrashPromotionConfidence: 0.97,
  autoTrashAutomatedLowValueConfidence: 0.98,
  autoStarImportanceScore: 0.85,
  autoStarImportanceConfidence: 0.9,
  autoCreateEventConfidence: 0.95
};

export interface MessagePolicyInput {
  gmailMessageId: string;
  /** True if INBOX label is currently present. */
  isInInbox: boolean;
  /** True if UNREAD label is absent (message has been read). */
  isRead: boolean;
  /** True if the message currently carries the native Gmail SPAM label. */
  isNativeSpam: boolean;
  /**
   * True if an explicit important rule matches, or the message carries a
   * preexisting STARRED/IMPORTANT label this app's ledger cannot attribute
   * to itself. Protected messages are never auto-trashed.
   */
  isProtected: boolean;
  /** A matching user-created rule, if any. Spam/important rules cannot overlap by construction. */
  explicitRule: { action: RuleAction; ruleGroupId: string } | null;
  /**
   * True when an authenticated high-risk transactional signal (security,
   * financial, delivery, medical/legal, etc.) is present. Gates the
   * promotion/automated-low-value trash path behind a real assessment.
   */
  hasAuthenticatedHighRiskSignal: boolean;
  /**
   * The AI assessment for this message, or null when AI was bypassed
   * (explicit rule / native spam) or produced no usable result.
   */
  assessment: EmailAssessment | null;
  /** True only when AI was expected to run (not bypassed) but did not produce a usable assessment. */
  assessmentUnavailable: boolean;
}

export type PolicyActionIntent =
  | { type: "trash"; reasonCode: string }
  | { type: "star"; reasonCode: string }
  | { type: "mark_important"; reasonCode: string }
  | { type: "archive"; reasonCode: string }
  | { type: "calendar_create"; reasonCode: string; event: EventCandidate };

export interface PolicyDecision {
  actions: readonly PolicyActionIntent[];
  needsReview: boolean;
  reviewReason: string | null;
}

function trashOnly(reasonCode: string): PolicyDecision {
  return { actions: [{ type: "trash", reasonCode }], needsReview: false, reviewReason: null };
}

function review(reasonCode: string, extra: PolicyActionIntent[] = []): PolicyDecision {
  return { actions: extra, needsReview: true, reviewReason: reasonCode };
}

/**
 * Pure deterministic policy: given fully-resolved local and AI signals for
 * one message, decide which actions to plan. No I/O, no clock, no randomness.
 * See CLAUDE.md "Deterministic action policy" for the precedence this encodes.
 */
export function evaluateMessagePolicy(
  input: MessagePolicyInput,
  thresholds: PolicyThresholds = DEFAULT_POLICY_THRESHOLDS
): PolicyDecision {
  // 1 & 2: explicit local spam rule, unless the message is protected (should
  // not occur because rule creation rejects protected overlaps, but defense
  // in depth: protection always wins over trash).
  if (input.explicitRule?.action === "spam") {
    if (input.isProtected) {
      return review("protected_message_conflicts_with_spam_rule");
    }
    return trashOnly("explicit_spam_rule");
  }

  // 3: unprotected native Gmail spam, no AI call needed.
  if (input.isNativeSpam) {
    if (input.isProtected) {
      return review("protected_native_spam_conflict");
    }
    return trashOnly("native_spam");
  }

  // From here on, only unprotected AI-derived signals may trigger Trash.
  // 4 & 6: an authenticated high-risk signal, or any failure to obtain a
  // usable assessment, blocks AI-derived trash/star/event entirely.
  const canUseAiMutations =
    !input.isProtected && input.assessment !== null && !input.assessmentUnavailable;

  const actions: PolicyActionIntent[] = [];
  let needsReview = false;
  let reviewReason: string | null = null;

  if (!input.isProtected && input.assessmentUnavailable) {
    needsReview = true;
    reviewReason = "assessment_unavailable";
  }

  if (canUseAiMutations && input.assessment) {
    const a = input.assessment;

    // 5: high-confidence promotion / automated_low_value -> trash, nothing else.
    const isTrashKind = a.kind === "promotion" || a.kind === "automated_low_value";
    const trashThreshold =
      a.kind === "promotion"
        ? thresholds.autoTrashPromotionConfidence
        : thresholds.autoTrashAutomatedLowValueConfidence;
    const trashEligible = isTrashKind && a.confidence >= trashThreshold;

    if (trashEligible && !input.hasAuthenticatedHighRiskSignal) {
      return trashOnly(`ai_${a.kind}`);
    }
    if (trashEligible && input.hasAuthenticatedHighRiskSignal) {
      // Veto: a promotional label/kind alone cannot override an
      // authenticated high-risk signal. Route to review instead of trashing.
      needsReview = true;
      reviewReason = "authenticated_high_risk_veto";
    }

    // 6: suspicious/unknown produce no AI-derived mutation of any kind
    // (no star, no important, no event), only review eligibility.
    const isUnresolvedKind = a.kind === "suspicious" || a.kind === "unknown";
    if (isUnresolvedKind) {
      needsReview = true;
      reviewReason ??= `ai_${a.kind}`;
    }

    if (!isUnresolvedKind) {
      // 7: star + important, unless already decided as review-only above for trash-eligible+veto.
      const importanceQualifies =
        a.importanceScore >= thresholds.autoStarImportanceScore &&
        a.importanceConfidence >= thresholds.autoStarImportanceConfidence;
      if (importanceQualifies) {
        actions.push({ type: "star", reasonCode: `ai_importance_${a.kind}` });
        actions.push({ type: "mark_important", reasonCode: `ai_importance_${a.kind}` });
      }

      // 8: high-confidence future event.
      if (
        a.event.intent === "create" &&
        a.event.confidence >= thresholds.autoCreateEventConfidence
      ) {
        actions.push({
          type: "calendar_create",
          reasonCode: `ai_event_${a.kind}`,
          event: a.event
        });
      }
    }
  }

  // An explicit important rule stars/marks important regardless of AI,
  // bypassing importance classification (but not event extraction above).
  if (input.explicitRule?.action === "important") {
    if (!actions.some((act) => act.type === "star")) {
      actions.push({ type: "star", reasonCode: "explicit_important_rule" });
    }
    if (!actions.some((act) => act.type === "mark_important")) {
      actions.push({ type: "mark_important", reasonCode: "explicit_important_rule" });
    }
  }

  // 9: every non-Trash message without UNREAD gets archived, even if
  // starred or used to create an event.
  if (input.isRead && input.isInInbox) {
    actions.push({ type: "archive", reasonCode: "read_non_trash" });
  }

  return { actions, needsReview, reviewReason };
}
