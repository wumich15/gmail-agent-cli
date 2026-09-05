import type { GmailAgentDatabase } from "../database.js";
import type { PlannedAction, RunRecord } from "../../core/models.js";

interface RunRow {
  run_id: string;
  account_hash: string;
  mode: string;
  policy_version: string;
  classifier_version: string | null;
  prompt_version: string | null;
  schema_version: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  counters: string;
  error_summary: string | null;
}

interface ActionRow {
  action_key: string;
  run_id: string;
  account_hash: string;
  type: string;
  target_gmail_message_id: string | null;
  target_gmail_thread_id: string | null;
  target_calendar_event_id: string | null;
  reason_code: string;
  before_state_hash: string | null;
  payload_hash: string;
  status: string;
  attempt_count: number;
  error_class: string | null;
  created_at: string;
  updated_at: string;
}

function runFromRow(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    accountHash: row.account_hash,
    mode: row.mode as RunRecord["mode"],
    policyVersion: row.policy_version,
    classifierVersion: row.classifier_version,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as RunRecord["status"],
    counters: JSON.parse(row.counters) as Record<string, number>,
    errorSummary: row.error_summary
  };
}

function actionFromRow(row: ActionRow): PlannedAction {
  return {
    actionKey: row.action_key,
    runId: row.run_id,
    accountHash: row.account_hash,
    type: row.type as PlannedAction["type"],
    targetGmailMessageId: row.target_gmail_message_id,
    targetGmailThreadId: row.target_gmail_thread_id,
    targetCalendarEventId: row.target_calendar_event_id,
    reasonCode: row.reason_code,
    beforeStateHash: row.before_state_hash,
    payloadHash: row.payload_hash,
    status: row.status as PlannedAction["status"],
    attemptCount: row.attempt_count,
    errorClass: row.error_class,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class RunsRepository {
  constructor(private readonly db: GmailAgentDatabase) {}

  create(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, account_hash, mode, policy_version, classifier_version, prompt_version, schema_version, started_at, finished_at, status, counters, error_summary)
         VALUES (@runId, @accountHash, @mode, @policyVersion, @classifierVersion, @promptVersion, @schemaVersion, @startedAt, @finishedAt, @status, @counters, @errorSummary)`
      )
      .run({
        runId: run.runId,
        accountHash: run.accountHash,
        mode: run.mode,
        policyVersion: run.policyVersion,
        classifierVersion: run.classifierVersion,
        promptVersion: run.promptVersion,
        schemaVersion: run.schemaVersion,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        status: run.status,
        counters: JSON.stringify(run.counters),
        errorSummary: run.errorSummary
      });
  }

  finish(runId: string, status: RunRecord["status"], finishedAt: string, counters: Record<string, number>, errorSummary: string | null): void {
    this.db
      .prepare(
        "UPDATE runs SET status = ?, finished_at = ?, counters = ?, error_summary = ? WHERE run_id = ?"
      )
      .run(status, finishedAt, JSON.stringify(counters), errorSummary, runId);
  }

  get(runId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  listRecent(accountHash: string, limit = 20): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE account_hash = ? ORDER BY started_at DESC LIMIT ?")
      .all(accountHash, limit) as RunRow[];
    return rows.map(runFromRow);
  }
}

export class ActionsRepository {
  constructor(private readonly db: GmailAgentDatabase) {}

  upsertPlanned(actions: readonly PlannedAction[]): void {
    const insert = this.db.prepare(
      `INSERT INTO actions (action_key, run_id, account_hash, type, target_gmail_message_id, target_gmail_thread_id, target_calendar_event_id, reason_code, before_state_hash, payload_hash, status, attempt_count, error_class, created_at, updated_at)
       VALUES (@actionKey, @runId, @accountHash, @type, @targetGmailMessageId, @targetGmailThreadId, @targetCalendarEventId, @reasonCode, @beforeStateHash, @payloadHash, @status, @attemptCount, @errorClass, @createdAt, @updatedAt)
       ON CONFLICT(action_key) DO UPDATE SET
         run_id = excluded.run_id,
         status = excluded.status,
         attempt_count = excluded.attempt_count,
         error_class = excluded.error_class,
         updated_at = excluded.updated_at`
    );
    const transaction = this.db.transaction(() => {
      for (const action of actions) {
        insert.run({
          actionKey: action.actionKey,
          runId: action.runId,
          accountHash: action.accountHash,
          type: action.type,
          targetGmailMessageId: action.targetGmailMessageId,
          targetGmailThreadId: action.targetGmailThreadId,
          targetCalendarEventId: action.targetCalendarEventId,
          reasonCode: action.reasonCode,
          beforeStateHash: action.beforeStateHash,
          payloadHash: action.payloadHash,
          status: action.status,
          attemptCount: action.attemptCount,
          errorClass: action.errorClass,
          createdAt: action.createdAt,
          updatedAt: action.updatedAt
        });
      }
    });
    transaction();
  }

  updateStatus(actionKey: string, status: PlannedAction["status"], updatedAt: string, errorClass: string | null = null): void {
    this.db
      .prepare(
        "UPDATE actions SET status = ?, attempt_count = attempt_count + 1, error_class = ?, updated_at = ? WHERE action_key = ?"
      )
      .run(status, errorClass, updatedAt, actionKey);
  }

  findApplying(accountHash: string): PlannedAction[] {
    const rows = this.db
      .prepare("SELECT * FROM actions WHERE account_hash = ? AND status = 'applying'")
      .all(accountHash) as ActionRow[];
    return rows.map(actionFromRow);
  }

  listForRun(runId: string): PlannedAction[] {
    const rows = this.db.prepare("SELECT * FROM actions WHERE run_id = ?").all(runId) as ActionRow[];
    return rows.map(actionFromRow);
  }
}
