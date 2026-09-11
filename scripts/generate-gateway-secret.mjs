#!/usr/bin/env node
/**
 * Generates a gateway secret with the platform CSPRNG.
 *
 * The production plan requires `GMAIL_AGENT_GATEWAY_SUBJECT_HMAC_KEY` to come
 * from a cryptographically secure generator rather than the example value in
 * the documentation, because that key is what makes the stored quota
 * identifiers pseudonymous: anyone holding it can re-derive which hash belongs
 * to a known Google subject.
 *
 * Usage: node scripts/generate-gateway-secret.mjs [byte-length]
 * The value is printed once, to stdout only. Paste it into the hosting
 * platform's secret manager; do not commit it or pass it on a command line.
 */
import { randomBytes } from "node:crypto";

const bytes = Number.parseInt(process.argv[2] ?? "48", 10);
if (!Number.isInteger(bytes) || bytes < 32 || bytes > 256) {
  console.error("Byte length must be an integer between 32 and 256 (default 48).");
  process.exit(2);
}

// base64url: no shell-quoting hazards and no padding to lose in a config UI.
process.stdout.write(`${randomBytes(bytes).toString("base64url")}\n`);
