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
}

export const SETTING_KEYS = {
  cacheLastRunAt: "gmail_cache_last_run_at",
  viewLastRefreshAt: "gmail_view_last_refresh_at"
} as const;
