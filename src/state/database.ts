import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations/index.js";

export type GmailAgentDatabase = Database.Database;

/**
 * Opens (creating if needed) the per-user SQLite database with the
 * durability and permission settings the design requires, then applies
 * any pending migrations. Refuses to proceed if the file is group/world
 * readable on platforms that support POSIX permissions.
 */
export function openDatabase(filePath: string): GmailAgentDatabase {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const isNewFile = !existsSync(filePath);
  const db = new Database(filePath);

  if (process.platform !== "win32") {
    chmodSync(filePath, 0o600);
    if (!isNewFile) {
      const mode = statSync(filePath).mode & 0o777;
      if (mode & 0o077) {
        db.close();
        throw new Error(
          `Refusing to use ${filePath}: permissions ${mode.toString(8)} are group/world-accessible.`
        );
      }
    }
  }

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  runMigrations(db);
  return db;
}

function runMigrations(db: GmailAgentDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedIds = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map((row) => (row as { id: number }).id)
  );

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)"
  );

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) {
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(migration.id, migration.name, new Date().toISOString());
    });
    apply();
  }
}
