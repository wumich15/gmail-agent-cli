import pc from "picocolors";
import type { RunSummary } from "./build-summary.js";

export function renderHumanSummary(
  summary: RunSummary,
  options: { dryRun: boolean; runId?: string }
): string {
  const lines: string[] = [];
  const totalTrashed = Object.values(summary.trashedByReason).reduce((a, b) => a + b, 0);
  const inboxAfter = summary.inboxCountBefore - totalTrashed - summary.archivedCount;

  lines.push(pc.bold(options.dryRun ? "Dry run — no changes were made" : "Run complete"));
  lines.push("");
  lines.push(`Inbox: ${summary.inboxCountBefore} before -> ${inboxAfter} after`);
  lines.push("");

  if (totalTrashed > 0) {
    lines.push(pc.bold(`Trashed (${totalTrashed})`));
    for (const [reason, count] of Object.entries(summary.trashedByReason)) {
      lines.push(`  ${count} ${reason}`);
    }
    lines.push("");
  }

  if (summary.starredCount > 0 || summary.markedImportantCount > 0) {
    lines.push(`Starred: ${summary.starredCount}   Marked important: ${summary.markedImportantCount}`);
    lines.push("");
  }

  if (summary.calendarCreatedCount > 0) {
    lines.push(`Calendar events created: ${summary.calendarCreatedCount}`);
    lines.push("");
  }

  lines.push(`Archived read mail: ${summary.archivedCount}`);
  lines.push(`Review / unchanged: ${summary.reviewCount}`);
  if (summary.reviewSamples.length > 0) {
    for (const sample of summary.reviewSamples) {
      lines.push(`  · ${sample.subject} — ${sample.sender} (${sample.reason})`);
    }
  }
  lines.push(`Failures: ${summary.failureCount}`);

  if (options.runId) {
    lines.push("");
    lines.push(
      pc.dim(`Every action from this run is listed in: gmail summary ${options.runId}`) +
        pc.dim(`   Undo with: gmail undo ${options.runId}`)
    );
  }

  return lines.join("\n");
}
