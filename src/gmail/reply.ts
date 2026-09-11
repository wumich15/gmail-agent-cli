import { setTimeout as delay } from "node:timers/promises";
import type { NormalizedMessage } from "../core/models.js";
import type { GmailClient } from "./client.js";
import { apiErrorStatus, isGoogleQuotaError, isRetryableNetworkError, withGoogleApiRetry } from "../core/api-retry.js";

export interface ReplyTarget {
  to: string;
  subject: string;
  threadId: string | null;
  inReplyTo: string | null;
  references: string | null;
}

/** A header value must never carry a raw CR/LF: RFC 5322 header lines are folded, and an unfolded literal CR/LF is exactly how a malicious sender would splice extra headers into an outbound message. */
const CONTAINS_CRLF = /[\r\n]/;

/** Collapses any embedded CR/LF (and surrounding whitespace) into a single space — never lets one become a header-line break. */
function sanitizeSingleLineHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[ \t]+/g, " ").trim();
}

/**
 * Derives the reply's recipient, subject, and threading deterministically
 * from the ORIGINAL message's own already-parsed headers — never from
 * anything an AI model outputs. This is the concrete answer to "how could
 * prompt injection manipulate a reply's recipient": it can't, because the
 * model is never asked to produce a recipient, subject, or thread ID in
 * the first place, regardless of what the source email's content claims.
 * Returns null when the message has no usable address to reply to at all,
 * or when the parsed address itself carries an embedded CR/LF — a real
 * email address never does, so that's treated as an injection attempt
 * rather than sanitized and used, matching how unsubscribe/headers.ts
 * already rejects CR/LF in an untrusted mailto address.
 */
export function buildReplyTarget(message: NormalizedMessage): ReplyTarget | null {
  const to = message.replyTo?.address ?? message.from.address;
  if (!to || CONTAINS_CRLF.test(to)) {
    return null;
  }
  const trimmedSubject = message.subject.trim();
  const subject = sanitizeSingleLineHeader(
    /^re:/i.test(trimmedSubject) ? trimmedSubject : `Re: ${trimmedSubject || "(no subject)"}`
  );
  const messageId = message.messageIdHeader ? sanitizeSingleLineHeader(message.messageIdHeader) : null;
  return {
    to,
    subject,
    threadId: message.gmailThreadId,
    inReplyTo: messageId,
    references: messageId
  };
}

/** Builds a new-message target from values the user typed and rejects header injection or malformed addresses. */
export function buildComposeTarget(toInput: string, subjectInput: string): ReplyTarget | null {
  if (CONTAINS_CRLF.test(toInput) || CONTAINS_CRLF.test(subjectInput)) return null;
  const recipients = toInput.split(",").map((value) => value.trim()).filter(Boolean);
  if (recipients.length === 0 || recipients.some((address) => !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(address))) {
    return null;
  }
  return {
    to: recipients.join(", "),
    subject: sanitizeSingleLineHeader(subjectInput) || "(no subject)",
    threadId: null,
    inReplyTo: null,
    references: null
  };
}

/** RFC 2047-encodes a header value only if it actually contains non-ASCII characters. Strips CR/LF first, defense-in-depth alongside buildReplyTarget's own rejection. */
function encodeHeaderValue(value: string): string {
  const sanitized = sanitizeSingleLineHeader(value);
  if (/^[\x00-\x7F]*$/.test(sanitized)) {
    return sanitized;
  }
  return `=?UTF-8?B?${Buffer.from(sanitized, "utf-8").toString("base64")}?=`;
}

/** Wraps base64 text at the RFC 2045-recommended 76 characters per line. */
function wrapBase64(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join("\r\n");
}

function buildRawMessage(target: ReplyTarget, body: string): string {
  const bodyIsAscii = /^[\x00-\x7F]*$/.test(body);
  const encodedBody = bodyIsAscii ? body : wrapBase64(Buffer.from(body, "utf-8").toString("base64"));
  const headers = [
    `To: ${sanitizeSingleLineHeader(target.to)}`,
    `Subject: ${encodeHeaderValue(target.subject)}`,
    ...(target.inReplyTo ? [`In-Reply-To: ${sanitizeSingleLineHeader(target.inReplyTo)}`] : []),
    ...(target.references ? [`References: ${sanitizeSingleLineHeader(target.references)}`] : []),
    "Content-Type: text/plain; charset=UTF-8",
    `Content-Transfer-Encoding: ${bodyIsAscii ? "7bit" : "base64"}`,
    "MIME-Version: 1.0"
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${encodedBody}`, "utf-8").toString("base64url");
}

/**
 * A send that did not report success, and whether the message might
 * nevertheless have gone out.
 *
 * `ambiguous` is the whole point: a 5xx or a dropped connection can arrive
 * *after* Gmail already accepted and delivered the message, so the only
 * honest thing to tell the user is that it may have been sent. Anything
 * else risks them sending a second copy of a mail that already landed.
 */
export class SendFailedError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean,
    override readonly cause: unknown
  ) {
    super(message);
    this.name = "SendFailedError";
  }
}

/**
 * True only when Gmail demonstrably rejected the request without queuing
 * anything — a 4xx. The message was not sent, so trying again cannot
 * duplicate it. A 5xx, a timeout, or a dropped connection proves nothing
 * either way and must never be retried automatically.
 */
function provablyNotSent(error: unknown): boolean {
  const status = apiErrorStatus(error);
  return status !== undefined && status >= 400 && status < 500;
}

/** Only a transient rejection is worth another attempt; a bad address never fixes itself. */
function worthRetrying(error: unknown): boolean {
  return provablyNotSent(error) && isGoogleQuotaError(error);
}

function describeSendError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_SEND_ATTEMPTS = 5;
const SEND_RETRY_BASE_DELAY_MS = 1_000;
const SEND_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Sends a reply. The caller is responsible for having already shown the
 * user the exact `target`/`body` and obtained explicit confirmation —
 * this function itself has no confirmation gate, by design (it's the
 * single, narrow point that actually calls `messages.send`, kept as small
 * and auditable as possible; see CLAUDE.md's "Interactive reply").
 *
 * `messages.send` is not idempotent and Gmail offers no idempotency key,
 * so this deliberately does NOT use the shared retry policy every other
 * call in this app uses. That policy retries 5xx and network failures,
 * which for a send means a message Gmail already accepted gets sent again
 * — one confirmation producing two or three identical emails under the
 * user's own name, which is exactly what this app's "never send without
 * explicit per-message confirmation" rule exists to prevent. Only a
 * request Gmail provably rejected (a 4xx, and then only a transient
 * quota-shaped one) is retried; every other failure is surfaced, marked
 * ambiguous, for the user to decide about — the same doctrine the
 * unsubscribe subsystem already applies to its one-click POST.
 */
export async function sendReply(client: GmailClient, target: ReplyTarget, body: string): Promise<void> {
  const raw = buildRawMessage(target, body);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await withGoogleApiRetry(
        () =>
          client.users.messages.send({
            userId: "me",
            requestBody: {
              raw,
              ...(target.threadId ? { threadId: target.threadId } : {})
            }
          }),
        { maxAttempts: 1 },
        5, // messages.send = 100 quota units
        "gmail.messages.send"
      );
      return;
    } catch (error) {
      if (worthRetrying(error) && attempt < MAX_SEND_ATTEMPTS) {
        await delay(Math.min(SEND_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), SEND_RETRY_MAX_DELAY_MS));
        continue;
      }
      const ambiguous = !provablyNotSent(error) || isRetryableNetworkError(error);
      throw new SendFailedError(describeSendError(error), ambiguous, error);
    }
  }
}
