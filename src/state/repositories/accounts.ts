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
  updateHistoryMarker(accountHash: string, historyMarker: string | null, updatedAt: string): void {
    this.db
      .prepare("UPDATE accounts SET history_marker = ?, updated_at = ? WHERE account_hash = ?")
      .run(historyMarker, updatedAt, accountHash);
  }
}
