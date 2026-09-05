import type { PolicyDecision } from "../core/policy.js";
import type { ValidatedEvent } from "../calendar/event-policy.js";

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
  archivedCount: number;
  archived: ActionDetail[];
  starredCount: number;
  starred: ActionDetail[];
  markedImportantCount: number;
  markedImportant: ActionDetail[];
  calendarCreatedCount: number;
  calendarCreated: ActionDetail[];
  reviewCount: number;
  /** Every Review item's subject/sender/reason — not capped, matching the rest of this summary. */
  reviewSamples: ActionDetail[];
  failureCount: number;
  /** Set when --limit capped the scan; states what was skipped. */
  scanNote: string | null;
}

/**
 * Builds the run summary deterministically from in-memory outcomes. No
 * second AI call narrates it; this only aggregates the plan already made.
 * Every category lists the exact subject/sender of every affected
 * message — the design's accepted trade-off for lower auto-action
 * thresholds is that nothing here is hidden or sampled.
 */
export function buildRunSummary(inboxCountBefore: number, outcomes: readonly MessageOutcome[]): RunSummary {
  const trashedByReason: Record<string, number> = {};
  const trashed: ActionDetail[] = [];
  const archived: ActionDetail[] = [];
  const starred: ActionDetail[] = [];
  const markedImportant: ActionDetail[] = [];
  const calendarCreated: ActionDetail[] = [];
  const reviewSamples: ActionDetail[] = [];
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
      }
    }
    if (outcome.decision.needsReview) {
      reviewCount += 1;
      reviewSamples.push(detail(outcome.decision.reviewReason ?? "unspecified"));
    }
  }

  return {
    inboxCountBefore,
    trashedByReason,
    trashed,
    archivedCount: archived.length,
    archived,
    starredCount: starred.length,
    starred,
    markedImportantCount: markedImportant.length,
    markedImportant,
    calendarCreatedCount: calendarCreated.length,
    calendarCreated,
    reviewCount,
    reviewSamples,
    failureCount: 0,
    scanNote: null
  };
}
