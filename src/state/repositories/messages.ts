import type { Statement } from "better-sqlite3";
import type { GmailAgentDatabase } from "../database.js";

/**
 * A minimal, non-verbatim projection of a message this account has already
 * seen — never the body text or any AI-generated summary/evidence, per
 * CLAUDE.md's "Keep secrets, full email bodies... out of SQLite." Written
 * by `gmail cache` (with every assessment field left null, since it never
 * calls the classifier) and available for a future assessment-reuse cache
 * keyed on `contentHash` plus the version columns. `subject`/`senderDisplay`/
 * `internalDate` back `gmail view`'s subject-line list — deliberately still
 * not the body, which `gmail view` always fetches live when a message is
 * opened.
 */
export interface CachedMessageRecord {
  accountHash: string;
  gmailMessageId: string;
  gmailThreadId: string;
  contentHash: string;
  labelSnapshot: readonly string[];
  classifierVersion: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  policyVersion: string | null;
  assessmentKind: string | null;
  assessmentConfidence: number | null;
  importanceScore: number | null;
  importanceConfidence: number | null;
  reasonCodes: readonly string[] | null;
  processedAt: string;
  /** Not sensitive-content-free like a body, but low-sensitivity enough to browse offline; see migration 003. */
  subject: string | null;
  senderDisplay: string | null;
  /** Gmail's internalDate (epoch millis, as a string) — used to sort gmail view's list most-recent-first. */
  internalDate: string | null;
  /** The AI-proposed topical category (e.g. "Shopping"), or null — see migration 005. */
  category: string | null;
  /** Whether the original cached assessment contained an event candidate; the candidate itself is never persisted. */
  assessmentHadEvent: boolean | null;
}

export type CachedMessageUpsert = Omit<CachedMessageRecord, "assessmentHadEvent"> & {
  /** Optional for compatibility with callers that do not yet produce this cache-safety metadata. */
  assessmentHadEvent?: boolean | null;
};

interface MessageRow {
  account_hash: string;
  gmail_message_id: string;
  gmail_thread_id: string;
  content_hash: string;
  label_snapshot: string;
  classifier_version: string | null;
  prompt_version: string | null;
  schema_version: string | null;
  policy_version: string | null;
  assessment_kind: string | null;
  assessment_confidence: number | null;
  importance_score: number | null;
  importance_confidence: number | null;
  reason_codes: string | null;
  processed_at: string;
  subject: string | null;
  sender_display: string | null;
  internal_date: string | null;
  category: string | null;
  assessment_had_event: number | null;
}

function fromRow(row: MessageRow): CachedMessageRecord {
  return {
    accountHash: row.account_hash,
    gmailMessageId: row.gmail_message_id,
    gmailThreadId: row.gmail_thread_id,
    contentHash: row.content_hash,
    labelSnapshot: JSON.parse(row.label_snapshot) as string[],
    classifierVersion: row.classifier_version,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    policyVersion: row.policy_version,
    assessmentKind: row.assessment_kind,
    assessmentConfidence: row.assessment_confidence,
    importanceScore: row.importance_score,
    importanceConfidence: row.importance_confidence,
    reasonCodes: row.reason_codes ? (JSON.parse(row.reason_codes) as string[]) : null,
    processedAt: row.processed_at,
    subject: row.subject,
    senderDisplay: row.sender_display,
    internalDate: row.internal_date,
    category: row.category,
    assessmentHadEvent: row.assessment_had_event === null ? null : row.assessment_had_event === 1
  };
}

export class MessagesRepository {
  private readonly getStatement: Statement;
  private readonly deleteStatement: Statement;
  private readonly upsertStatement: Statement;

  constructor(private readonly db: GmailAgentDatabase) {
    this.getStatement = db.prepare("SELECT * FROM messages WHERE account_hash = ? AND gmail_message_id = ?");
    this.deleteStatement = db.prepare("DELETE FROM messages WHERE account_hash = ? AND gmail_message_id = ?");
    this.upsertStatement = db.prepare(UPSERT_SQL);
  }

  get(accountHash: string, gmailMessageId: string): CachedMessageRecord | null {
    const row = this.getStatement.get(accountHash, gmailMessageId) as MessageRow | undefined;
    return row ? fromRow(row) : null;
  }

  countForAccount(accountHash: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE account_hash = ?")
      .get(accountHash) as { n: number };
    return row.n;
  }

  /** `gmail view`'s data source: every cached message for this account, most-recent first. Filtering/pagination happen in memory — local mailbox sizes here are small enough that this is simpler and fast enough. */
  listForAccount(accountHash: string): CachedMessageRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE account_hash = ? ORDER BY CAST(internal_date AS INTEGER) DESC"
      )
      .all(accountHash) as MessageRow[];
    return rows.map(fromRow);
  }

  /** `gmail uncache`'s counterpart to `gmail cache`'s population of this table. Returns how many rows were removed. */
  clearForAccount(accountHash: string): number {
    return this.db.prepare("DELETE FROM messages WHERE account_hash = ?").run(accountHash).changes;
  }

  /** Removes a cache projection Gmail has proven deleted or outside the caller's chosen cache scope. */
  delete(accountHash: string, gmailMessageId: string): boolean {
    return this.deleteStatement.run(accountHash, gmailMessageId).changes > 0;
  }

  /** Persists a bounded hydration chunk with one durable SQLite commit. */
  applyCacheBatch(
    accountHash: string,
    records: readonly CachedMessageUpsert[],
    deletedMessageIds: readonly string[] = []
  ): void {
    if (records.length === 0 && deletedMessageIds.length === 0) return;
    this.db.transaction(() => {
      for (const record of records) {
        if (record.accountHash !== accountHash) throw new Error("Cache batch spans multiple accounts.");
        this.upsert(record);
      }
      for (const id of deletedMessageIds) this.delete(accountHash, id);
    })();
  }

  upsertMany(records: readonly CachedMessageUpsert[]): void {
    if (records.length === 0) return;
    this.db.transaction(() => {
      for (const record of records) this.upsert(record);
    })();
  }

  upsert(record: CachedMessageUpsert): void {
    this.upsertStatement.run({
        accountHash: record.accountHash,
        gmailMessageId: record.gmailMessageId,
        gmailThreadId: record.gmailThreadId,
        contentHash: record.contentHash,
        labelSnapshot: JSON.stringify([...record.labelSnapshot].sort()),
        classifierVersion: record.classifierVersion,
        promptVersion: record.promptVersion,
        schemaVersion: record.schemaVersion,
        policyVersion: record.policyVersion,
        assessmentKind: record.assessmentKind,
        assessmentConfidence: record.assessmentConfidence,
        importanceScore: record.importanceScore,
        importanceConfidence: record.importanceConfidence,
        reasonCodes: record.reasonCodes ? JSON.stringify(record.reasonCodes) : null,
        processedAt: record.processedAt,
        subject: record.subject,
        senderDisplay: record.senderDisplay,
        internalDate: record.internalDate,
        category: record.category,
        assessmentHadEvent:
          record.assessmentHadEvent === null || record.assessmentHadEvent === undefined
            ? null
            : Number(record.assessmentHadEvent)
      });
  }
}

const UPSERT_SQL = `INSERT INTO messages (account_hash, gmail_message_id, gmail_thread_id, content_hash, label_snapshot, classifier_version, prompt_version, schema_version, policy_version, assessment_kind, assessment_confidence, importance_score, importance_confidence, reason_codes, processed_at, subject, sender_display, internal_date, category, assessment_had_event)
         VALUES (@accountHash, @gmailMessageId, @gmailThreadId, @contentHash, @labelSnapshot, @classifierVersion, @promptVersion, @schemaVersion, @policyVersion, @assessmentKind, @assessmentConfidence, @importanceScore, @importanceConfidence, @reasonCodes, @processedAt, @subject, @senderDisplay, @internalDate, @category, @assessmentHadEvent)
         ON CONFLICT(account_hash, gmail_message_id) DO UPDATE SET
           gmail_thread_id = excluded.gmail_thread_id,
           content_hash = excluded.content_hash,
           label_snapshot = excluded.label_snapshot,
           classifier_version = excluded.classifier_version,
           prompt_version = excluded.prompt_version,
           schema_version = excluded.schema_version,
           policy_version = excluded.policy_version,
           assessment_kind = excluded.assessment_kind,
           assessment_confidence = excluded.assessment_confidence,
           importance_score = excluded.importance_score,
           importance_confidence = excluded.importance_confidence,
           reason_codes = excluded.reason_codes,
           processed_at = excluded.processed_at,
           subject = excluded.subject,
           sender_display = excluded.sender_display,
           internal_date = excluded.internal_date,
           category = excluded.category,
           assessment_had_event = excluded.assessment_had_event`;
