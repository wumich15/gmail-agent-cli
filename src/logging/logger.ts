import pino from "pino";
import { logDir } from "../config/paths.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const REDACT_PATHS = [
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.body",
  "*.snippet",
  "*.description",
  "*.query"
];

/** Structured, content-free logging: run IDs, counts, hashes, reason codes — never email content or credentials. */
export function createLogger(options: { toFile?: boolean } = {}): pino.Logger {
  if (options.toFile) {
    const dir = logDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return pino(
      { redact: { paths: REDACT_PATHS, censor: "[redacted]" }, level: "info" },
      pino.destination({ dest: join(dir, "gmail-agent.log"), mkdir: true })
    );
  }
  return pino({
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    level: process.env["GMAIL_AGENT_LOG_LEVEL"] ?? "info",
    transport: { target: "pino/file", options: { destination: 2 } }
  });
}
