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
  // Only trashed messages that actually carried INBOX count against the
  // Inbox total — native-Spam trashes (the majority of `totalTrashed` on
  // a typical run) were never part of inboxCountBefore to begin with, so
  // subtracting the full trash count here would overcount how much the
  // Inbox actually shrank.
  const inboxAfter = summary.inboxCountBefore - summary.inboxTrashedCount - summary.archivedCount;

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

  if (summary.labeledCount > 0) {
    lines.push(pc.bold(`Labeled: ${summary.labeledCount}`));
    printDetails(lines, summary.labeled);
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

  lines.push("");
  lines.push(renderImportantEmailsParagraph(summary));

  return lines.join("\n");
}

/** A short, plaintext plan shown before any Gmail/Calendar mutation starts. */
export function renderExecutiveSummary(summary: RunSummary): string {
  const trashCount = Object.values(summary.trashedByReason).reduce((total, count) => total + count, 0);
  const importantCount = summary.markedImportant.length;
  return [
    `Executive summary: ${summary.inboxCountBefore} Inbox message(s) scanned; planned actions — ` +
      `${trashCount} trash, ${summary.archivedCount} archive, ${summary.starredCount} star, ` +
      `${importantCount} important, ${summary.labeledCount} label, ${summary.calendarCreatedCount} calendar, ` +
      `${summary.reviewCount} review.`,
    importantCount > 0
      ? `Important emails: ${summary.markedImportant.map((item) => `${item.subject} from ${item.sender}`).join("; ")}.`
      : "Important emails: none identified in this run."
  ].join(" ");
}

/** Full, concise, plaintext paragraph of every message marked important this run. */
export function renderImportantEmailsParagraph(summary: RunSummary): string {
  if (summary.markedImportant.length === 0) {
    return "Important emails: none identified in this run.";
  }
  return `Important emails: ${summary.markedImportant
    .map((item) => `${item.subject} from ${item.sender}`)
    .join("; ")}.`;
}
