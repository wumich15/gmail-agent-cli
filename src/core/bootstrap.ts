import type { Logger } from "pino";
import { createLogger } from "../logging/logger.js";
import { databaseFilePath } from "../config/paths.js";
import { openDatabase, type GmailAgentDatabase } from "../state/database.js";
import { OsCredentialStore, type CredentialStore } from "../auth/credential-store.js";
import { SystemClock, type Clock } from "./clock.js";
import { loadConfig } from "../config/load.js";
import type { Config } from "../config/schema.js";

export interface CliContext {
  db: GmailAgentDatabase;
  credentialStore: CredentialStore;
  logger: Logger;
  clock: Clock;
  config: Config | null;
}

let cached: CliContext | null = null;

/** Wires the process-wide singletons commands share. Opens the DB once per process. */
export function bootstrap(): CliContext {
  cached ??= {
    db: openDatabase(databaseFilePath()),
    credentialStore: new OsCredentialStore(),
    // Structured diagnostics go to a dedicated log file (see logDir()),
    // not stderr — stderr is reserved for the CLI's own human-readable
    // progress lines (CLAUDE.md: "progress to stderr"), and interleaving
    // raw JSON log lines with those would make both harder to read.
    logger: createLogger({ toFile: true }),
    clock: new SystemClock(),
    config: loadConfig()
  };
  return cached;
}
