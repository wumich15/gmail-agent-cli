import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount } from "./shared.js";
import { DEFAULT_LOCK_WAIT_MS, ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { EXIT_CODES } from "../core/errors.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { MessagesRepository } from "../state/repositories/messages.js";
import { LabelCandidatesRepository } from "../state/repositories/label-candidates.js";
import { SETTING_KEYS, SettingsRepository } from "../state/repositories/settings.js";

export interface UncacheOptions {
  yes: boolean;
}

/**
 * `gmail uncache` — the inverse of `gmail cache`: clears this account's
 * local scan-derived state (the `messages` table's per-message
 * projections, pending topical-label candidate counts, and the Gmail
 * working/view history markers) without making a single Gmail or Calendar API call.
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
        "This clears the local Gmail scan cache and history markers for this account — no Gmail or Calendar " +
        "changes, but cleanup/cache will need a full snapshot and gmail view will progressively reload. Continue?"
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
  lock.acquire({ waitMs: DEFAULT_LOCK_WAIT_MS });
  try {
    // Cache rows and both independent history fences are one logical reset.
    // Clearing only the rows before a crash while leaving the view fence
    // would make a genuinely empty cache look complete on the next launch.
    const { messagesCleared, candidatesCleared } = ctx.db.transaction(() => {
      const cleared = {
        messagesCleared: new MessagesRepository(ctx.db).clearForAccount(account.accountHash),
        candidatesCleared: new LabelCandidatesRepository(ctx.db).clearForAccount(account.accountHash)
      };
      const nowIso = ctx.clock.nowIso();
      new AccountsRepository(ctx.db).updateHistoryMarker(account.accountHash, null, nowIso);
      const settings = new SettingsRepository(ctx.db);
      settings.delete(account.accountHash, SETTING_KEYS.viewHistoryMarker);
      settings.delete(account.accountHash, SETTING_KEYS.viewFullCacheAt);
      settings.delete(account.accountHash, SETTING_KEYS.viewLastRefreshAt);
      return cleared;
    })();

    console.log(
      pc.green(
        `Cleared ${messagesCleared} cached message record(s) and ${candidatesCleared} pending label candidate(s), ` +
          "and reset the history markers. The next cleanup/cache run will do a full snapshot, and gmail view " +
          "will progressively rebuild its folders."
      )
    );
    return EXIT_CODES.ok;
  } finally {
    lock.release();
  }
}
