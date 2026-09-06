import type { GmailAgentDatabase } from "../database.js";

/**
 * A minimal, non-verbatim projection of a message this account has already
 * seen — never the body text or any AI-generated summary/evidence, per
 * CLAUDE.md's "Keep secrets, full email bodies... out of SQLite." Written
 * by `gmail cache` (with every assessment field left null, since it never
 * calls the classifier) and available for a future assessment-reuse cache
 * keyed on `contentHash` plus the version columns.
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
}

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
    processedAt: row.processed_at
  };
}

export class MessagesRepository {
  constructor(private readonly db: GmailAgentDatabase) {}

  get(accountHash: string, gmailMessageId: string): CachedMessageRecord | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE account_hash = ? AND gmail_message_id = ?")
      .get(accountHash, gmailMessageId) as MessageRow | undefined;
    return row ? fromRow(row) : null;
  }

  countForAccount(accountHash: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE account_hash = ?")
      .get(accountHash) as { n: number };
    return row.n;
  }

  /** `gmail uncache`'s counterpart to `gmail cache`'s population of this table. Returns how many rows were removed. */
  clearForAccount(accountHash: string): number {
    return this.db.prepare("DELETE FROM messages WHERE account_hash = ?").run(accountHash).changes;
  }

  upsert(record: CachedMessageRecord): void {
    this.db
      .prepare(
        `INSERT INTO messages (account_hash, gmail_message_id, gmail_thread_id, content_hash, label_snapshot, classifier_version, prompt_version, schema_version, policy_version, assessment_kind, assessment_confidence, importance_score, importance_confidence, reason_codes, processed_at)
         VALUES (@accountHash, @gmailMessageId, @gmailThreadId, @contentHash, @labelSnapshot, @classifierVersion, @promptVersion, @schemaVersion, @policyVersion, @assessmentKind, @assessmentConfidence, @importanceScore, @importanceConfidence, @reasonCodes, @processedAt)
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
           processed_at = excluded.processed_at`
      )
      .run({
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
        processedAt: record.processedAt
      });
  }
}
