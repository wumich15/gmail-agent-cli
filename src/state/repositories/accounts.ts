import type { GmailAgentDatabase } from "../database.js";
import type { AccountRecord } from "../../core/models.js";

interface AccountRow {
  account_hash: string;
  email_display: string | null;
  timezone: string;
  history_marker: string | null;
  setup_complete: number;
  automation_enabled: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: AccountRow): AccountRecord {
  return {
    accountHash: row.account_hash,
    emailDisplay: row.email_display,
    timezone: row.timezone,
    historyMarker: row.history_marker,
    setupComplete: row.setup_complete === 1,
    automationEnabled: row.automation_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface AccountScopedTable {
  table: string;
  column: string;
}

/**
 * Every table that points at `accounts`, read from the live schema rather
 * than hardcoded here, so a future migration that adds an account-scoped
 * table is covered without anyone having to remember to update this list.
 */
function accountScopedTables(db: GmailAgentDatabase): AccountScopedTable[] {
  return db
    .prepare(
      `SELECT m.name AS "table", f."from" AS "column"
         FROM sqlite_master m
         JOIN pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = 'accounts'`
    )
    .all() as AccountScopedTable[];
}

export class AccountsRepository {
  constructor(private readonly db: GmailAgentDatabase) {}

  get(accountHash: string): AccountRecord | null {
    const row = this.db
      .prepare("SELECT * FROM accounts WHERE account_hash = ?")
      .get(accountHash) as AccountRow | undefined;
    return row ? fromRow(row) : null;
  }

  upsert(record: AccountRecord): void {
    this.db
      .prepare(
        `INSERT INTO accounts (account_hash, email_display, timezone, history_marker, setup_complete, automation_enabled, created_at, updated_at)
         VALUES (@accountHash, @emailDisplay, @timezone, @historyMarker, @setupComplete, @automationEnabled, @createdAt, @updatedAt)
         ON CONFLICT(account_hash) DO UPDATE SET
           email_display = excluded.email_display,
           timezone = excluded.timezone,
           history_marker = excluded.history_marker,
           setup_complete = excluded.setup_complete,
           automation_enabled = excluded.automation_enabled,
           updated_at = excluded.updated_at`
      )
      .run({
        accountHash: record.accountHash,
        emailDisplay: record.emailDisplay,
        timezone: record.timezone,
        historyMarker: record.historyMarker,
        setupComplete: record.setupComplete ? 1 : 0,
        automationEnabled: record.automationEnabled ? 1 : 0,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      });
  }

  /** Pass null to reset the marker (e.g. `gmail uncache`), forcing the next scan to do a full snapshot. */
  /** Sets the marker to exactly this value, including null. `gmail uncache`'s deliberate reset. */
  updateHistoryMarker(accountHash: string, historyMarker: string | null, updatedAt: string): void {
    this.db
      .prepare("UPDATE accounts SET history_marker = ?, updated_at = ? WHERE account_hash = ?")
      .run(historyMarker, updatedAt, accountHash);
  }

  /**
   * Moves the marker forward, or leaves it alone when this pass did not earn
   * a new one.
   *
   * Scan checkpoints must never *retreat* a marker to null. A marker means
   * "everything up to here has been seen", which stays true no matter how
   * little the current run managed to process — while clearing it forces the
   * next run into a full Inbox+Spam re-listing. That is the opposite of what
   * a user reaching for `--limit` wants, since they are capping the scan
   * precisely because they are under Gmail quota pressure.
   */
  advanceHistoryMarker(accountHash: string, historyMarker: string | null, updatedAt: string): void {
    this.db
      .prepare(
        "UPDATE accounts SET history_marker = COALESCE(?, history_marker), updated_at = ? WHERE account_hash = ?"
      )
      .run(historyMarker, updatedAt, accountHash);
  }

  /**
   * Deletes the account rows matching `predicate` together with every row
   * scoped to them.
   *
   * The child tables carry a plain `REFERENCES accounts(account_hash)` with
   * no `ON DELETE CASCADE`, so deleting an account row by itself raises
   * "FOREIGN KEY constraint failed" as soon as that account has any local
   * history at all — which is the state every real install is in. That is
   * what made signing in as a second Google account fail outright: the
   * single-account rule in `core/connect.ts` deletes the previous account,
   * and the previous account had cached messages, runs, and actions.
   *
   * `defer_foreign_keys` holds enforcement until the transaction commits, so
   * the child deletes need no dependency ordering among themselves (`actions`
   * references `runs`, for instance); by commit time every referencing row is
   * gone. It resets automatically at the end of the transaction.
   */
  private purge(predicate: string, accountHash: string): void {
    const tables = accountScopedTables(this.db);
    this.db.transaction(() => {
      this.db.pragma("defer_foreign_keys = ON");
      for (const { table, column } of tables) {
        this.db.prepare(`DELETE FROM "${table}" WHERE "${column}" ${predicate}`).run(accountHash);
      }
      this.db.prepare(`DELETE FROM accounts WHERE account_hash ${predicate}`).run(accountHash);
    })();
  }

  /** Forgets one account and all of its local history. `gmail auth logout` with history removal. */
  delete(accountHash: string): void {
    this.purge("= ?", accountHash);
  }

  /**
   * Forgets every account other than this one, enforcing the v1 single-account
   * rule when the user signs in as a different Google account.
   */
  deleteAllExcept(accountHash: string): void {
    this.purge("!= ?", accountHash);
  }

}
