import type { PolicyDecision } from "../core/policy.js";
import type { ValidatedEvent } from "../calendar/event-policy.js";
import type { RuleMatcher } from "../core/models.js";
import { isInInbox } from "../gmail/labels.js";

/** A repeated, unread bulk sender that can safely become a persistent spam rule. */
export interface AutomaticSpamRuleCandidate {
  categoryName: string;
  matcher: RuleMatcher;
}

export interface MessageOutcome {
  gmailMessageId: string;
  gmailThreadId: string;
  subjectForDisplay: string;
  senderForDisplay: string;
  decision: PolicyDecision;
  bypassReason: "explicit_spam_rule" | "explicit_important_rule" | "native_spam" | null;
  /** Label snapshot at scan time, used to hash the before-state for the action ledger. */
  labelIdsAtSnapshot: readonly string[];
  /** Present only when decision.actions contains a calendar_create that passed real-code date validation. */
  validatedEvent: ValidatedEvent | null;
  /** The classifier version that produced this message's assessment, if any (for Calendar provenance). */
  classifierVersion: string | null;
  /** Gmail's internalDate (epoch millis, as a string), used to order the summary most-recent-first. */
  internalDate: string;
  /** True when UNREAD is present at scan time. */
  isUnread: boolean;
  /** Present when this outcome contributes to an automatic repeated-bulk spam rule. */
  automaticSpamRuleCandidate?: AutomaticSpamRuleCandidate | null;
}

export interface ActionDetail {
  subject: string;
  sender: string;
  reasonCode: string;
}

export interface RunSummary {
  inboxCountBefore: number;
  trashedByReason: Record<string, number>;
  /** Every trashed message's subject/sender, not just the count — full audit trail, never truncated. */
  trashed: ActionDetail[];
  /**
   * How many of the trashed messages actually carried INBOX at snapshot
   * time — the only trash count that's valid to subtract from
   * `inboxCountBefore`. `trashed`/`trashedByReason` intentionally include
   * every trash (native Spam included, which was never counted in
   * inboxCountBefore to begin with), so summing those against the Inbox
   * count would overcount how much the Inbox actually shrank.
   */
  inboxTrashedCount: number;
  archivedCount: number;
  archived: ActionDetail[];
  starredCount: number;
  starred: ActionDetail[];
  markedImportantCount: number;
  markedImportant: ActionDetail[];
  calendarCreatedCount: number;
  calendarCreated: ActionDetail[];
  labeledCount: number;
  /** Every applied/planned label action's subject/sender, with the label name itself in place of a reasonCode. */
  labeled: ActionDetail[];
  reviewCount: number;
  /** Every Review item's subject/sender/reason — not capped, matching the rest of this summary. */
  reviewSamples: ActionDetail[];
  /** A quick, bounded, most-recent-first look at unread mail regardless of what (if anything) happened to it. */
  recentUnread: ActionDetail[];
  /** Every message that received no action and wasn't flagged for Review either — full list, never truncated. */
  unchanged: ActionDetail[];
  failureCount: number;
  /** Set when --limit capped the scan; states what was skipped. */
  scanNote: string | null;
}

const MAX_RECENT_UNREAD = 10;

/**
 * Builds the run summary deterministically from in-memory outcomes. No
 * second AI call narrates it; this only aggregates the plan already made.
 * Every category lists the exact subject/sender of every affected
 * message — the design's accepted trade-off for lower auto-action
 * thresholds is that nothing here is hidden or sampled. `outcomes` is
 * expected most-recent-first (core/orchestrator.ts sorts it that way),
 * which this function relies on for `recentUnread` and preserves for
 * `unchanged`.
 */
export function buildRunSummary(inboxCountBefore: number, outcomes: readonly MessageOutcome[]): RunSummary {
  const trashedByReason: Record<string, number> = {};
  const trashed: ActionDetail[] = [];
  let inboxTrashedCount = 0;
  const archived: ActionDetail[] = [];
  const starred: ActionDetail[] = [];
  const markedImportant: ActionDetail[] = [];
  const calendarCreated: ActionDetail[] = [];
  const labeled: ActionDetail[] = [];
  const reviewSamples: ActionDetail[] = [];
  const recentUnread: ActionDetail[] = [];
  const unchanged: ActionDetail[] = [];
  let reviewCount = 0;

  for (const outcome of outcomes) {
    const detail = (reasonCode: string): ActionDetail => ({
      subject: outcome.subjectForDisplay,
      sender: outcome.senderForDisplay,
      reasonCode
    });

    for (const action of outcome.decision.actions) {
      switch (action.type) {
        case "trash":
          trashedByReason[action.reasonCode] = (trashedByReason[action.reasonCode] ?? 0) + 1;
          trashed.push(detail(action.reasonCode));
          if (isInInbox(outcome.labelIdsAtSnapshot)) {
            inboxTrashedCount += 1;
          }
          break;
        case "archive":
          archived.push(detail(action.reasonCode));
          break;
        case "star":
          starred.push(detail(action.reasonCode));
          break;
        case "mark_important":
          markedImportant.push(detail(action.reasonCode));
          break;
        case "calendar_create":
          calendarCreated.push(detail(action.reasonCode));
          break;
        case "label":
          labeled.push(detail(action.labelName));
          break;
      }
    }
    if (outcome.decision.needsReview) {
      reviewCount += 1;
      reviewSamples.push(detail(outcome.decision.reviewReason ?? "unspecified"));
    } else if (outcome.decision.actions.length === 0) {
      unchanged.push(detail("no_action"));
    }

    if (outcome.isUnread && recentUnread.length < MAX_RECENT_UNREAD) {
      const actionSummary =
        outcome.decision.actions.length > 0
          ? outcome.decision.actions.map((a) => a.type).join("+")
          : outcome.decision.needsReview
            ? "review"
            : "no_action";
      recentUnread.push(detail(actionSummary));
    }
  }

  return {
    inboxCountBefore,
    trashedByReason,
    trashed,
    inboxTrashedCount,
    archivedCount: archived.length,
    archived,
    starredCount: starred.length,
    starred,
    markedImportantCount: markedImportant.length,
    markedImportant,
    calendarCreatedCount: calendarCreated.length,
    calendarCreated,
    labeledCount: labeled.length,
    labeled,
    reviewCount,
    reviewSamples,
    recentUnread,
    unchanged,
    failureCount: 0,
    scanNote: null
  };
}
