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

export interface RunSummary {
  inboxCountBefore: number;
  trashedByReason: Record<string, number>;
  archivedCount: number;
  starredCount: number;
  markedImportantCount: number;
  calendarCreatedCount: number;
  reviewCount: number;
  reviewSamples: { subject: string; sender: string; reason: string }[];
  failureCount: number;
  /** Set when --limit capped the scan; states what was skipped. */
  scanNote: string | null;
}

const MAX_REVIEW_SAMPLES = 5;

/**
 * Builds the run summary deterministically from in-memory outcomes. No
 * second AI call narrates it; this only aggregates the plan already made.
 */
export function buildRunSummary(inboxCountBefore: number, outcomes: readonly MessageOutcome[]): RunSummary {
  const trashedByReason: Record<string, number> = {};
  let archivedCount = 0;
  let starredCount = 0;
  let markedImportantCount = 0;
  let calendarCreatedCount = 0;
  let reviewCount = 0;
  const reviewSamples: RunSummary["reviewSamples"] = [];

  for (const outcome of outcomes) {
    for (const action of outcome.decision.actions) {
      switch (action.type) {
        case "trash":
          trashedByReason[action.reasonCode] = (trashedByReason[action.reasonCode] ?? 0) + 1;
          break;
        case "archive":
          archivedCount += 1;
          break;
        case "star":
          starredCount += 1;
          break;
        case "mark_important":
          markedImportantCount += 1;
          break;
        case "calendar_create":
          calendarCreatedCount += 1;
          break;
      }
    }
    if (outcome.decision.needsReview) {
      reviewCount += 1;
      if (reviewSamples.length < MAX_REVIEW_SAMPLES) {
        reviewSamples.push({
          subject: outcome.subjectForDisplay,
          sender: outcome.senderForDisplay,
          reason: outcome.decision.reviewReason ?? "unspecified"
        });
      }
    }
  }

  return {
    inboxCountBefore,
    trashedByReason,
    archivedCount,
    starredCount,
    markedImportantCount,
    calendarCreatedCount,
    reviewCount,
    reviewSamples,
    failureCount: 0,
    scanNote: null
  };
}
