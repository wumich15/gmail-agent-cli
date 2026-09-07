import { contentHash } from "../core/ids.js";
import type { EmailAddress, NormalizedMessage } from "../core/models.js";
import type { gmail_v1 } from "googleapis";

const MAX_BODY_CHARS = 6000;

/**
 * Walks a Gmail message payload's MIME tree for the first plain-text and
 * HTML parts. Does not fetch or return attachment bytes.
 */
export function extractBodyParts(payload: gmail_v1.Schema$MessagePart | undefined): {
  plain: string | null;
  html: string | null;
} {
  let plain: string | null = null;
  let html: string | null = null;

  function visit(part: gmail_v1.Schema$MessagePart | undefined): void {
    if (!part) return;
    const mimeType = part.mimeType ?? "";
    const data = part.body?.data;
    if (data && mimeType === "text/plain" && plain === null) {
      plain = decodeBase64Url(data);
    } else if (data && mimeType === "text/html" && html === null) {
      html = decodeBase64Url(data);
    }
    for (const child of part.parts ?? []) {
      visit(child);
    }
  }

  visit(payload);
  return { plain, html };
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

export interface GmailHeaderMap {
  from: string | null;
  replyTo: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  messageId: string | null;
  authenticationResults: string | null;
  dkimSignature: string | null;
  listId: string | null;
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
}

export function headerMapFromList(
  headers: readonly { name?: string | null; value?: string | null }[] | undefined
): GmailHeaderMap {
  const lookup = new Map<string, string>();
  for (const h of headers ?? []) {
    if (h.name && h.value !== undefined && h.value !== null) {
      const key = h.name.toLowerCase();
      // Keep the FIRST occurrence, not the last. A message can carry
      // multiple copies of a header (e.g. Authentication-Results added by
      // each hop it passed through); Gmail returns them in the order they
      // physically appear, which places the receiving server's own most
      // recently prepended header first. Silently keeping whichever
      // occurrence happens to be last is an unprincipled choice for a
      // header that feeds security-relevant DKIM/DMARC matching.
      if (!lookup.has(key)) {
        lookup.set(key, h.value);
      }
    }
  }
  const get = (name: string): string | null => lookup.get(name.toLowerCase()) ?? null;
  return {
    from: get("From"),
    replyTo: get("Reply-To"),
    to: get("To"),
    subject: get("Subject"),
    date: get("Date"),
    messageId: get("Message-ID"),
    authenticationResults: get("Authentication-Results"),
    dkimSignature: get("DKIM-Signature"),
    listId: get("List-ID"),
    listUnsubscribe: get("List-Unsubscribe"),
    listUnsubscribePost: get("List-Unsubscribe-Post"),
    autoSubmitted: get("Auto-Submitted"),
    precedence: get("Precedence")
  };
}

/** Parses a single RFC 5322 "Display Name <addr>" or bare address. Best-effort, no external deps. */
export function parseEmailAddress(raw: string | null): EmailAddress | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  // [\s\S] instead of "." for the display-name capture: "." never matches
  // a newline, so a header value containing an embedded literal newline
  // (folded/unfolded oddly) would fall through to the "bare" branch below
  // and use the whole garbled string — brackets and all — as the address.
  const angleMatch = /^([\s\S]*)<([^<>]+)>\s*$/.exec(trimmed);
  if (angleMatch) {
    const displayNameRaw = angleMatch[1]!.trim().replace(/^"|"$/g, "");
    const address = angleMatch[2]!.trim();
    return {
      raw: trimmed,
      address: address.length > 0 ? address.toLowerCase() : null,
      displayName: displayNameRaw.length > 0 ? displayNameRaw : null
    };
  }
  const bare = trimmed.replace(/^"|"$/g, "");
  return {
    raw: trimmed,
    address: bare.includes("@") ? bare.toLowerCase() : null,
    displayName: bare.includes("@") ? null : bare || null
  };
}

/** Parses a comma-separated address list, respecting quoted display names. */
export function parseEmailAddressList(raw: string | null): EmailAddress[] {
  if (raw === null) {
    return [];
  }
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inQuotes = false;
  for (const char of raw) {
    if (char === '"') {
      inQuotes = !inQuotes;
    }
    if (!inQuotes) {
      if (char === "<") depth++;
      if (char === ">") depth = Math.max(0, depth - 1);
    }
    if (char === "," && depth === 0 && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts.map((p) => parseEmailAddress(p)).filter((a): a is EmailAddress => a !== null);
}

/** Strips script/style/tags to bounded, plain text. Never rendered as HTML anywhere downstream. */
export function htmlToBoundedPlainText(html: string, maxChars: number = MAX_BODY_CHARS): { text: string; truncated: boolean } {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // A malformed or deliberately adversarial email with an unclosed
    // <script>/<style> tag would otherwise leave everything after it —
    // potentially the rest of the message, including raw JS/CSS source —
    // completely unstripped: the paired regexes above simply don't match
    // when there's no closing tag, and the generic tag-stripper further
    // below only removes angle-bracketed fragments, not the plain-text
    // code between them. Treat a still-open tag as "the remainder of the
    // document is inside it."
    .replace(/<script\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Redact URLs that carry secret-looking query values (tokens, signatures).
  text = text.replace(
    /https?:\/\/\S*[?&](?:token|sig|signature|auth|key|secret|otp)=[^\s&]+/gi,
    "[redacted-url]"
  );

  text = stripQuotedReplyHistory(text);
  text = collapseWhitespace(text);

  if (text.length > maxChars) {
    return { text: text.slice(0, maxChars), truncated: true };
  }
  return { text, truncated: false };
}

function stripQuotedReplyHistory(text: string): string {
  const markers = [
    /\nOn .+ wrote:\n[\s\S]*$/,
    /\n-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i,
    /\nFrom:.*\nSent:.*\nTo:.*\nSubject:[\s\S]*$/i
  ];
  let result = text;
  for (const marker of markers) {
    result = result.replace(marker, "");
  }
  return result
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n");
}

function collapseWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface BuildNormalizedMessageInput {
  gmailMessageId: string;
  gmailThreadId: string;
  historyId: string;
  internalDate: string;
  labelIds: readonly string[];
  snippet: string;
  headers: GmailHeaderMap;
  htmlBody: string | null;
  plainBody: string | null;
  userEmail: string;
  threadHasUserSentMessage: boolean;
}

export function buildNormalizedMessage(input: BuildNormalizedMessageInput): NormalizedMessage {
  const from = parseEmailAddress(input.headers.from) ?? {
    raw: "",
    address: null,
    displayName: null
  };
  let bodyText: string | null = null;
  let bodyTruncated = false;
  if (input.plainBody !== null) {
    const { text, truncated } = boundPlainText(input.plainBody);
    bodyText = text;
    bodyTruncated = truncated;
  } else if (input.htmlBody !== null) {
    const { text, truncated } = htmlToBoundedPlainText(input.htmlBody);
    bodyText = text;
    bodyTruncated = truncated;
  }

  // Deliberately excludes labelIds: label state (read/starred/archived/
  // etc.) is already tracked separately as its own label_snapshot column
  // wherever this hash is persisted (see state/repositories/messages.ts).
  // Folding labels into the content hash meant a label-only change (by
  // far the most common kind of change surfaced by incremental Gmail
  // history sync) also changed "content changed," defeating the hash's
  // entire purpose of answering "does this message's actual content
  // still match what was last seen."
  const hashInput = JSON.stringify({
    from: input.headers.from,
    subject: input.headers.subject,
    date: input.headers.date,
    messageId: input.headers.messageId,
    // These are the remaining values that actually affect
    // buildClassificationInput: when there is no inline body the Gmail
    // snippet is the model input, and the three bulk/list headers feed its
    // derived signal. Leaving them out could turn a materially different
    // classifier input into a false cache hit.
    snippetFallback: bodyText === null ? input.snippet : null,
    listId: input.headers.listId,
    autoSubmitted: input.headers.autoSubmitted,
    precedence: input.headers.precedence,
    bodyText,
    bodyTruncated
  });

  return {
    gmailMessageId: input.gmailMessageId,
    gmailThreadId: input.gmailThreadId,
    historyId: input.historyId,
    internalDate: input.internalDate,
    labelIds: input.labelIds,
    from,
    replyTo: parseEmailAddress(input.headers.replyTo),
    to: parseEmailAddressList(input.headers.to),
    subject: input.headers.subject ?? "",
    dateHeader: input.headers.date,
    messageIdHeader: input.headers.messageId,
    listId: input.headers.listId,
    listUnsubscribeHeader: input.headers.listUnsubscribe,
    listUnsubscribePost: input.headers.listUnsubscribePost,
    autoSubmitted: input.headers.autoSubmitted,
    precedence: input.headers.precedence,
    authenticationResults: input.headers.authenticationResults,
    dkimSignature: input.headers.dkimSignature,
    snippet: input.snippet,
    bodyText,
    bodyTruncated,
    contentHash: contentHash(hashInput),
    isFromUser: from.address !== null && from.address === input.userEmail.toLowerCase(),
    threadHasUserSentMessage: input.threadHasUserSentMessage
  };
}

function boundPlainText(text: string, maxChars: number = MAX_BODY_CHARS): { text: string; truncated: boolean } {
  const collapsed = collapseWhitespace(stripQuotedReplyHistory(text));
  if (collapsed.length > maxChars) {
    return { text: collapsed.slice(0, maxChars), truncated: true };
  }
  return { text: collapsed, truncated: false };
}
