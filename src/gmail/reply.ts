import type { NormalizedMessage } from "../core/models.js";
import type { GmailClient } from "./client.js";
import { withGoogleApiRetry } from "../core/api-retry.js";

export interface ReplyTarget {
  to: string;
  subject: string;
  threadId: string;
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
 * Sends a reply. The caller is responsible for having already shown the
 * user the exact `target`/`body` and obtained explicit confirmation —
 * this function itself has no confirmation gate, by design (it's the
 * single, narrow point that actually calls `messages.send`, kept as small
 * and auditable as possible; see CLAUDE.md's "Interactive reply").
 */
export async function sendReply(client: GmailClient, target: ReplyTarget, body: string): Promise<void> {
  await withGoogleApiRetry(() =>
    client.users.messages.send({
      userId: "me",
      requestBody: {
        raw: buildRawMessage(target, body),
        threadId: target.threadId
      }
    })
  );
}
