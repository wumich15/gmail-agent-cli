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

/**
 * Best-effort secret scrubbing for plain strings that never pass through
 * the structured `pino` logger above — most concretely, an unexpected
 * error's message/stack printed by the CLI's top-level catch-all. A
 * Google/OpenAI SDK error object can embed a bearer token, an
 * Authorization header value, or a token-bearing URL in its own message
 * or stack, and CLAUDE.md's "never include... tokens... in logs or
 * output" applies just as much to an unexpected-error path as it does to
 * a deliberate log line.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI-style API keys
  /\bya29\.[A-Za-z0-9\-_]+/g, // Google OAuth access tokens
  /\b1\/\/[A-Za-z0-9\-_]{10,}/g, // Google OAuth refresh tokens
  /((?:refresh|access)_token|api[_-]?key|client_secret)\s*[=:]\s*["']?[A-Za-z0-9\-._~+/]+=*["']?/gi,
  /Authorization:.*/gi
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

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
