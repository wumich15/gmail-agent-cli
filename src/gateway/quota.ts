import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

export class GatewayQuotaExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("The included AI service usage limit has been reached. Please try again later.");
    this.name = "GatewayQuotaExceededError";
  }
}

export interface GatewayQuotaOptions {
  databasePath: string;
  requestsPerMinute: number;
  requestsPerDay: number;
}

/** Persistent per-Google-account request quotas. No email address or raw Google subject is stored. */
export class GatewayQuota {
  private readonly db: Database.Database;
  private readonly reserveTransaction: (subjectHash: string, nowMs: number) => void;

  constructor(private readonly options: GatewayQuotaOptions) {
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    }
    const isNew = options.databasePath === ":memory:" || !existsSync(options.databasePath);
    if (process.platform !== "win32" && options.databasePath !== ":memory:" && !isNew) {
      const mode = statSync(options.databasePath).mode & 0o777;
      if (mode & 0o077) {
        throw new Error(
          `Refusing to use the gateway quota database: permissions ${mode.toString(8)} are group/world-accessible.`
        );
      }
    }
    this.db = new Database(options.databasePath);
    if (process.platform !== "win32" && options.databasePath !== ":memory:") {
      chmodSync(options.databasePath, 0o600);
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id INTEGER PRIMARY KEY,
        subject_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ai_usage_subject_time ON ai_usage(subject_hash, created_at_ms);
    `);

    const minuteCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM ai_usage WHERE subject_hash = ? AND created_at_ms >= ?"
    );
    const insert = this.db.prepare("INSERT INTO ai_usage(subject_hash, created_at_ms) VALUES (?, ?)");
    const cleanup = this.db.prepare("DELETE FROM ai_usage WHERE created_at_ms < ?");

    this.reserveTransaction = this.db.transaction((subjectHash: string, nowMs: number) => {
      const minuteStart = nowMs - 60_000;
      const dayStart = nowMs - 86_400_000;
      const minute = (minuteCount.get(subjectHash, minuteStart) as { count: number }).count;
      if (minute >= this.options.requestsPerMinute) throw new GatewayQuotaExceededError(60);
      const day = (minuteCount.get(subjectHash, dayStart) as { count: number }).count;
      if (day >= this.options.requestsPerDay) throw new GatewayQuotaExceededError(3_600);
      insert.run(subjectHash, nowMs);
      cleanup.run(nowMs - 7 * 86_400_000);
    });
  }

  reserve(subjectHash: string, nowMs = Date.now()): void {
    this.reserveTransaction(subjectHash, nowMs);
  }

  close(): void {
    this.db.close();
  }
}
