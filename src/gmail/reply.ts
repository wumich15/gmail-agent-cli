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

/**
 * Derives the reply's recipient, subject, and threading deterministically
 * from the ORIGINAL message's own already-parsed headers — never from
 * anything an AI model outputs. This is the concrete answer to "how could
 * prompt injection manipulate a reply's recipient": it can't, because the
 * model is never asked to produce a recipient, subject, or thread ID in
 * the first place, regardless of what the source email's content claims.
 * Returns null when the message has no usable address to reply to at all.
 */
export function buildReplyTarget(message: NormalizedMessage): ReplyTarget | null {
  const to = message.replyTo?.address ?? message.from.address;
  if (!to) {
    return null;
  }
  const trimmedSubject = message.subject.trim();
  const subject = /^re:/i.test(trimmedSubject) ? trimmedSubject : `Re: ${trimmedSubject || "(no subject)"}`;
  return {
    to,
    subject,
    threadId: message.gmailThreadId,
    inReplyTo: message.messageIdHeader,
    references: message.messageIdHeader
  };
}

/** RFC 2047-encodes a header value only if it actually contains non-ASCII characters. */
function encodeHeaderValue(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function buildRawMessage(target: ReplyTarget, body: string): string {
  const headers = [
    `To: ${target.to}`,
    `Subject: ${encodeHeaderValue(target.subject)}`,
    ...(target.inReplyTo ? [`In-Reply-To: ${target.inReplyTo}`] : []),
    ...(target.references ? [`References: ${target.references}`] : []),
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0"
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf-8").toString("base64url");
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
