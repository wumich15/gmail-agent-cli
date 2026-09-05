import type { ActionDetail, RunSummary } from "./build-summary.js";

export interface JsonSummaryOutput {
  dryRun: boolean;
  inboxCountBefore: number;
  inboxCountAfter: number;
  trashedByReason: Record<string, number>;
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
  reviewSamples: ActionDetail[];
  recentUnread: ActionDetail[];
  unchanged: ActionDetail[];
  failureCount: number;
  scanNote: string | null;
}

/** One stable JSON object to stdout. Never includes message bodies, tokens, or unsubscribe URLs. */
export function renderJsonSummary(summary: RunSummary, options: { dryRun: boolean }): JsonSummaryOutput {
  const totalTrashed = Object.values(summary.trashedByReason).reduce((a, b) => a + b, 0);
  return {
    dryRun: options.dryRun,
    inboxCountBefore: summary.inboxCountBefore,
    inboxCountAfter: summary.inboxCountBefore - totalTrashed - summary.archivedCount,
    trashedByReason: summary.trashedByReason,
    trashed: summary.trashed,
    archivedCount: summary.archivedCount,
    archived: summary.archived,
    starredCount: summary.starredCount,
    starred: summary.starred,
    markedImportantCount: summary.markedImportantCount,
    markedImportant: summary.markedImportant,
    calendarCreatedCount: summary.calendarCreatedCount,
    calendarCreated: summary.calendarCreated,
    reviewCount: summary.reviewCount,
    reviewSamples: summary.reviewSamples,
    recentUnread: summary.recentUnread,
    unchanged: summary.unchanged,
    failureCount: summary.failureCount,
    scanNote: summary.scanNote
  };
}
