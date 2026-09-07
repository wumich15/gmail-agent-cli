import type { GmailAgentDatabase } from "../database.js";

/**
 * Tracks how many messages (cumulatively, across runs) have proposed a
 * given AI-guessed topical category that hasn't cleared the
 * MIN_LABEL_BATCH_SIZE threshold yet (see core/orchestrator.ts). Without
 * this, incremental Gmail history sync means a normal run only ever sees
 * a handful of changed messages, so a brand-new category could almost
 * never accumulate enough occurrences in a single run to actually get
 * created — this table lets those occurrences accumulate across runs
 * instead. A row is deleted once the category crosses the threshold and
 * the label is actually created (see custom-labels.ts): from then on the
 * label already exists, so `existingLabels` context alone is enough to
 * keep applying it, with no further counting needed.
 */
export interface LabelCandidateRecord {
  accountHash: string;
  normalizedName: string;
  displayName: string;
  pendingCount: number;
  updatedAt: string;
}

interface LabelCandidateRow {
  account_hash: string;
  normalized_name: string;
  display_name: string;
  pending_count: number;
  updated_at: string;
}

function fromRow(row: LabelCandidateRow): LabelCandidateRecord {
  return {
    accountHash: row.account_hash,
    normalizedName: row.normalized_name,
    displayName: row.display_name,
    pendingCount: row.pending_count,
    updatedAt: row.updated_at
  };
}

export class LabelCandidatesRepository {
  constructor(private readonly db: GmailAgentDatabase) {}

  listForAccount(accountHash: string): LabelCandidateRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM label_candidates WHERE account_hash = ?")
      .all(accountHash) as LabelCandidateRow[];
    return rows.map(fromRow);
  }

  /** Overwrites the stored cumulative count/display name for one candidate (the caller already computed the new total). */
  upsert(record: LabelCandidateRecord): void {
    this.db
      .prepare(
        `INSERT INTO label_candidates (account_hash, normalized_name, display_name, pending_count, updated_at)
         VALUES (@accountHash, @normalizedName, @displayName, @pendingCount, @updatedAt)
         ON CONFLICT(account_hash, normalized_name) DO UPDATE SET
           display_name = excluded.display_name,
           pending_count = excluded.pending_count,
           updated_at = excluded.updated_at`
      )
      .run({
        accountHash: record.accountHash,
        normalizedName: record.normalizedName,
        displayName: record.displayName,
        pendingCount: record.pendingCount,
        updatedAt: record.updatedAt
      });
  }

  /** Removes a candidate once it crosses the threshold and the label is actually created — also drops its voted-message-ID rows, which no longer serve any purpose once counting for that name stops. */
  clear(accountHash: string, normalizedName: string): void {
    this.db
      .prepare("DELETE FROM label_candidates WHERE account_hash = ? AND normalized_name = ?")
      .run(accountHash, normalizedName);
    this.db
      .prepare("DELETE FROM label_candidate_votes WHERE account_hash = ? AND normalized_name = ?")
      .run(accountHash, normalizedName);
  }

  /** `gmail uncache`: drops every pending candidate (and vote record) for this account. Returns how many candidate rows were removed. */
  clearForAccount(accountHash: string): number {
    const changes = this.db.prepare("DELETE FROM label_candidates WHERE account_hash = ?").run(accountHash).changes;
    this.db.prepare("DELETE FROM label_candidate_votes WHERE account_hash = ?").run(accountHash);
    return changes;
  }

  /**
   * Every message ID that has already been counted toward a category's
   * cumulative count in a previous run, grouped by normalized category
   * name — used to make sure a message reconciled again by a later
   * incremental sync (e.g. because it was separately starred) never votes
   * for the same category twice. See migration 004's doc comment.
   */
  listVotedMessageIdsForAccount(accountHash: string): Map<string, Set<string>> {
    const rows = this.db
      .prepare("SELECT normalized_name, gmail_message_id FROM label_candidate_votes WHERE account_hash = ?")
      .all(accountHash) as { normalized_name: string; gmail_message_id: string }[];
    const result = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = result.get(row.normalized_name);
      if (set) {
        set.add(row.gmail_message_id);
      } else {
        result.set(row.normalized_name, new Set([row.gmail_message_id]));
      }
    }
    return result;
  }

  /** Records that these messages have now voted for this category, so a later run never double-counts them. */
  recordVotes(accountHash: string, normalizedName: string, gmailMessageIds: readonly string[]): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO label_candidate_votes (account_hash, normalized_name, gmail_message_id) VALUES (?, ?, ?)"
    );
    const insertMany = this.db.transaction((ids: readonly string[]) => {
      for (const id of ids) {
        insert.run(accountHash, normalizedName, id);
      }
    });
    insertMany(gmailMessageIds);
  }
}
