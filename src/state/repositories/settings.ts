import type { GmailAgentDatabase } from "../database.js";

/** Small typed facade over the existing per-account settings table. */
export class SettingsRepository {
  constructor(private readonly db: GmailAgentDatabase) {}

  get(accountHash: string, key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE account_hash = ? AND key = ?")
      .get(accountHash, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(accountHash: string, key: string, value: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (account_hash, key, value, version, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(account_hash, key) DO UPDATE SET
           value = excluded.value,
           version = settings.version + 1,
           updated_at = excluded.updated_at`
      )
      .run(accountHash, key, value, updatedAt);
  }

  delete(accountHash: string, key: string): boolean {
    return this.db.prepare("DELETE FROM settings WHERE account_hash = ? AND key = ?").run(accountHash, key).changes > 0;
  }
}

export const SETTING_KEYS = {
  cacheLastRunAt: "gmail_cache_last_run_at",
  viewLastRefreshAt: "gmail_view_last_refresh_at",
  /** History fence earned by a complete Inbox/Archive/Trash/Spam view snapshot. */
  viewHistoryMarker: "gmail_view_history_marker",
  /** Presence means every top-level gmail view folder has completed one full snapshot. */
  viewFullCacheAt: "gmail_view_full_cache_at",
  /**
   * Newest SENT message ID recorded by the reply-protection thread index
   * (see `gmail/sent-index.ts`). Its presence is what lets a later run
   * page the SENT label only down to this point instead of re-walking the
   * entire mailbox before it can trash anything.
   */
  sentIndexNewestMessageId: "gmail_sent_index_newest_message_id",
  /**
   * A short, non-verbatim description of the user's writing style (see
   * `gmail/writing-style.ts`), computed once from a Sent-mail sample and
   * reused across sessions instead of re-deriving it on every AI draft.
   * Never the raw sent examples themselves — CLAUDE.md forbids persisting
   * message bodies; this value is deliberately designed (by its generating
   * prompt) to never reproduce them verbatim.
   */
  writingStyleProfile: "gmail_writing_style_profile"
} as const;
