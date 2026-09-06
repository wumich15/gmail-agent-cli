import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount } from "./shared.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { EXIT_CODES } from "../core/errors.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { MessagesRepository } from "../state/repositories/messages.js";
import { LabelCandidatesRepository } from "../state/repositories/label-candidates.js";

export interface UncacheOptions {
  yes: boolean;
}

/**
 * `gmail uncache` — the inverse of `gmail cache`: clears this account's
 * local scan-derived state (the `messages` table's per-message
 * projections, pending topical-label candidate counts, and the Gmail
 * history marker) without making a single Gmail or Calendar API call.
 * Nothing about the real mailbox changes; this only resets what this app
 * remembers locally. The next `gmail`/`gmail work`/`gmail cache` run
 * afterward falls back to a full snapshot, exactly as if this were the
 * account's first-ever run — the same recovery path as an expired history
 * marker (see CLAUDE.md's "Incremental synchronization"), just triggered
 * deliberately instead of by a 404 from Gmail.
 */
export async function runUncache(options: UncacheOptions): Promise<number> {
  const ctx = bootstrap();
  const { account } = await resolveAccount(ctx);

  if (!options.yes) {
    const confirmed = await p.confirm({
      message:
        "This clears the local Gmail scan cache and history marker for this account — no Gmail or Calendar " +
        "changes, but the next run will do a full snapshot again instead of an incremental one. Continue?"
    });
    if (p.isCancel(confirmed) || !confirmed) {
      console.log("Cancelled. No changes were made.");
      return EXIT_CODES.safetyBlocked;
    }
  }

  // Mutates durable local state, so it needs the same per-account lock as
  // every other mutating command, even though nothing here ever touches
  // Gmail/Calendar.
  const lock = new ProcessLock(lockFilePath(account.accountHash));
  lock.acquire();
  try {
    const messagesCleared = new MessagesRepository(ctx.db).clearForAccount(account.accountHash);
    const candidatesCleared = new LabelCandidatesRepository(ctx.db).clearForAccount(account.accountHash);
    new AccountsRepository(ctx.db).updateHistoryMarker(account.accountHash, null, ctx.clock.nowIso());

    console.log(
      pc.green(
        `Cleared ${messagesCleared} cached message record(s) and ${candidatesCleared} pending label candidate(s), ` +
          "and reset the history marker. The next gmail/gmail work/gmail cache run will do a full snapshot."
      )
    );
    return EXIT_CODES.ok;
  } finally {
    lock.release();
  }
}
