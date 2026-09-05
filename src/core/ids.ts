import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Non-reversible account identifier used to namespace credentials and rows. */
export function accountHashFromEmail(email: string): string {
  return sha256Hex(`gmail-agent-account-v1\0${email.trim().toLowerCase()}`);
}

export function newRunId(): string {
  return `run_${randomBytes(12).toString("hex")}`;
}

export function newRuleGroupId(): string {
  return `rule_${randomBytes(9).toString("hex")}`;
}

/**
 * Deterministic action key: identical logical action (same type, target,
 * and payload) always resolves to the same key, independent of run ID, so
 * a crash-and-restart or a later run reconciles instead of duplicating.
 */
export function deterministicActionKey(parts: {
  accountHash: string;
  type: string;
  target: string;
  payloadHash: string;
}): string {
  return sha256Hex(
    `gmail-agent-action-v1\0${parts.accountHash}\0${parts.type}\0${parts.target}\0${parts.payloadHash}`
  );
}

const BASE32HEX_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

/** RFC 4648 base32hex, lowercase, no padding — matches Calendar event ID charset. */
export function toBase32Hex(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32HEX_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32HEX_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * Deterministic Google Calendar event ID for the first (only, in v1)
 * candidate derived from a given message. Same inputs always produce the
 * same ID so retries and later runs never create duplicate events.
 */
export function deterministicCalendarEventId(parts: {
  accountHash: string;
  gmailMessageId: string;
  candidateIndex: number;
}): string {
  const digest = createHash("sha256")
    .update(
      `gmail-agent-calendar-v1\0${parts.accountHash}\0${parts.gmailMessageId}\0candidate-${parts.candidateIndex}`
    )
    .digest();
  // Google requires 5-1024 chars from [a-v0-9]; 26 base32hex chars from a
  // 160-bit digest keeps collision probability negligible.
  return toBase32Hex(digest).slice(0, 26);
}

export function contentHash(input: string): string {
  return sha256Hex(`gmail-agent-content-v1\0${input}`);
}

export function payloadHash(payload: unknown): string {
  return sha256Hex(`gmail-agent-payload-v1\0${JSON.stringify(payload)}`);
}
