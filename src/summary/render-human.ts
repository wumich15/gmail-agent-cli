import pc from "picocolors";
import type { ActionDetail, RunSummary } from "./build-summary.js";

function printDetails(lines: string[], details: readonly ActionDetail[]): void {
  for (const item of details) {
    lines.push(`  · ${item.subject} — ${item.sender} (${item.reasonCode})`);
  }
}

export function renderHumanSummary(
  summary: RunSummary,
  options: { dryRun: boolean; runId?: string }
): string {
  const lines: string[] = [];
  const totalTrashed = Object.values(summary.trashedByReason).reduce((a, b) => a + b, 0);
  const inboxAfter = summary.inboxCountBefore - totalTrashed - summary.archivedCount;

  lines.push(pc.bold(options.dryRun ? "Dry run — no changes were made" : "Run complete"));
  lines.push("");
  if (summary.scanNote) {
    lines.push(pc.yellow(summary.scanNote));
  }
  lines.push(`Inbox: ${summary.inboxCountBefore} before -> ${inboxAfter} after`);
  lines.push("");

  // Quick executive summary first, most-recent-first: what's unread right
  // now and what (if anything) happened to it, before the fuller
  // category-by-category breakdown below.
  if (summary.recentUnread.length > 0) {
    lines.push(pc.bold(`Most recent unread (${summary.recentUnread.length})`));
    printDetails(lines, summary.recentUnread);
    lines.push("");
  }

  if (totalTrashed > 0) {
    lines.push(pc.bold(`Trashed (${totalTrashed})`));
    for (const [reason, count] of Object.entries(summary.trashedByReason)) {
      lines.push(`  ${count} ${reason}`);
    }
    printDetails(lines, summary.trashed);
    lines.push("");
  }

  if (summary.starredCount > 0 || summary.markedImportantCount > 0) {
    lines.push(pc.bold(`Starred: ${summary.starredCount}   Marked important: ${summary.markedImportantCount}`));
    printDetails(lines, summary.starred);
    printDetails(lines, summary.markedImportant);
    lines.push("");
  }

  if (summary.calendarCreatedCount > 0) {
    lines.push(pc.bold(`Calendar events created: ${summary.calendarCreatedCount}`));
    printDetails(lines, summary.calendarCreated);
    lines.push("");
  }

  lines.push(pc.bold(`Archived read mail: ${summary.archivedCount}`));
  printDetails(lines, summary.archived);
  lines.push("");

  lines.push(pc.bold(`Review: ${summary.reviewCount}`));
  printDetails(lines, summary.reviewSamples);
  lines.push("");

  lines.push(pc.bold(`Unchanged, no action taken (${summary.unchanged.length})`));
  printDetails(lines, summary.unchanged);
  lines.push(`Failures: ${summary.failureCount}`);

  if (options.runId) {
    lines.push("");
    // `gmail summary`/`gmail undo` aren't registered CLI commands in this
    // build (see ARCHITECTURE.md's "Command surface"), so this points at
    // the run ID rather than a command that would currently fail to parse.
    lines.push(pc.dim(`Run ID: ${options.runId} (every action is recorded in the local action ledger).`));
  }

  return lines.join("\n");
}
