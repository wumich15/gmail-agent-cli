import type { RunSummary } from "./build-summary.js";

export interface JsonSummaryOutput {
  dryRun: boolean;
  inboxCountBefore: number;
  inboxCountAfter: number;
  trashedByReason: Record<string, number>;
  archivedCount: number;
  starredCount: number;
  markedImportantCount: number;
  calendarCreatedCount: number;
  reviewCount: number;
  failureCount: number;
}

/** One stable JSON object to stdout. Never includes message bodies, tokens, or unsubscribe URLs. */
export function renderJsonSummary(summary: RunSummary, options: { dryRun: boolean }): JsonSummaryOutput {
  const totalTrashed = Object.values(summary.trashedByReason).reduce((a, b) => a + b, 0);
  return {
    dryRun: options.dryRun,
    inboxCountBefore: summary.inboxCountBefore,
    inboxCountAfter: summary.inboxCountBefore - totalTrashed - summary.archivedCount,
    trashedByReason: summary.trashedByReason,
    archivedCount: summary.archivedCount,
    starredCount: summary.starredCount,
    markedImportantCount: summary.markedImportantCount,
    calendarCreatedCount: summary.calendarCreatedCount,
    reviewCount: summary.reviewCount,
    failureCount: summary.failureCount
  };
}
