import { randomBytes } from "node:crypto";
import type { OAuth2Client } from "google-auth-library";

/**
 * Dedicated Gmail multipart-batch read transport (CLAUDE.md's "Planned
 * Gmail read-transport optimization", step 3). Scoped deliberately narrow —
 * it only knows how to batch `users.messages.get` reads, not an arbitrary
 * mix of Gmail endpoints, matching the plan's "emits multipart/mixed
 * requests containing only relative users/me/messages/<id>?format=...&
 * fields=... paths."
 *
 * Batching and gzip are transport optimizations, not quota bypasses: this
 * module never claims a batch of `n` inner calls costs less than `n`
 * individual calls — see `gmail/batch-hydrate.ts` for how the caller
 * reserves quota for every inner call before sending, and `core/api-retry.ts`
 * for the shared adaptive limiter this reserves against.
 *
 * Deliberately built on `OAuth2Client.request` (the same gaxios/node-fetch
 * pipeline `googleapis`-generated clients use under the hood) rather than a
 * raw `fetch`, so the same automatic gzip response decompression the
 * individual-call path already gets "for free" applies here too. The one
 * thing `OAuth2Client.request` does NOT do that `googleapis-common`'s
 * wrapper does for ordinary calls is set `Accept-Encoding: gzip` and a
 * gzip-tagged `User-Agent` itself — this module sets both explicitly so the
 * two transports stay equivalent (see CLAUDE.md: "any custom batch
 * transport introduced below must explicitly preserve those two headers").
 */

const DEFAULT_BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
const BATCH_USER_AGENT = "gmail-agent-cli-batch/1 (gzip)";
/** Gmail prefixes every batch response part's Content-ID with this; strip it to recover the id this code sent. */
const RESPONSE_CONTENT_ID_PREFIX = "response-";

/**
 * Thrown when the outer batch HTTP request itself fails or the response
 * can't be parsed as a multipart/mixed batch at all — i.e. there is no
 * usable per-part information whatsoever. Callers (see `batch-hydrate.ts`)
 * treat this as "the whole batch failed" and fall back to individual reads
 * for every id in it; a per-part failure (a message that came back 404, or
 * one which failed transiently) is NOT this — see `BatchSendResult.failed`.
 */
export class BatchTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BatchTransportError";
  }
}

export interface BatchPartFailure {
  status: number | null;
  /** True for a transient-shaped failure (429/5xx, or a part this response couldn't safely attribute) worth retrying; false for a terminal one (404/400) that a retry cannot fix. */
  retryable: boolean;
  detail: string;
}

export interface BatchSendResult {
  /** Gmail message ID -> the decoded 2xx JSON body. */
  succeeded: Map<string, unknown>;
  /** Gmail message ID -> failure detail. Every id passed in ends up in exactly one of `succeeded`/`failed`, even one this response never actually accounted for. */
  failed: Map<string, BatchPartFailure>;
}

/** Builds the `GET /gmail/v1/users/me/messages/<id>?...` relative path Gmail's batch protocol expects for one inner call. */
export function messageGetPath(messageId: string, format: string, fields: string): string {
  return `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=${encodeURIComponent(format)}&fields=${encodeURIComponent(fields)}`;
}

/**
 * Builds the multipart/mixed request body. Each part's `Content-ID` is the
 * plain Gmail message ID (no extra encoding scheme needed — IDs are already
 * unique per request), which is exactly what comes back on the response
 * side (mapping by `Content-ID`, not by array position, is what makes
 * out-of-order parts safe to handle — see `parseBatchResponseBody`).
 */
export function buildBatchRequestBody(ids: readonly string[], pathFor: (id: string) => string, boundary: string): string {
  const lines: string[] = [];
  for (const id of ids) {
    lines.push(`--${boundary}`);
    lines.push("Content-Type: application/http");
    lines.push(`Content-ID: <${id}>`);
    lines.push("");
    lines.push(`GET ${pathFor(id)} HTTP/1.1`);
    lines.push("");
  }
  lines.push(`--${boundary}--`);
  return lines.join("\r\n");
}

/** Extracts the `boundary` parameter from a `Content-Type: multipart/mixed; boundary=...` header value. */
export function extractBoundary(contentType: string | undefined | null): string | null {
  if (!contentType) return null;
  const match = /boundary="?([^";]+)"?/i.exec(contentType);
  return match ? match[1]! : null;
}

export interface ParsedBatchPart {
  contentId: string | null;
  status: number | null;
  body: unknown;
  parseError: string | null;
}

/**
 * Splits a multipart/mixed batch response body by its boundary and decodes
 * each embedded HTTP response (status line + body). Deliberately never
 * throws on a single malformed/unmappable part — every anomaly comes back
 * as a `ParsedBatchPart` with `parseError` set, and the caller
 * (`sendGmailMessagesBatch`) is what turns "no usable parts at all" into a
 * `BatchTransportError`. A missing/duplicate `Content-ID` cannot be
 * attributed to any request id, so it is surfaced here but reconciled by
 * the caller against the full requested-id list, never silently dropped.
 */
export function parseBatchResponseBody(rawBody: string, boundary: string): ParsedBatchPart[] {
  const delimiter = `--${boundary}`;
  const segments = rawBody.split(delimiter);
  const parts: ParsedBatchPart[] = [];
  for (const rawSegment of segments) {
    const segment = rawSegment.replace(/^\r\n/, "");
    // The final segment after the closing "--boundary--" marker, any MIME
    // preamble/epilogue text outside the boundary structure, and unrelated
    // garbage that never contained a real batch part are not parts at all
    // — only a segment that actually looks like one (carries the
    // `Content-Type: application/http` marker every real batch part has)
    // is handed to parseOnePart.
    if (!/^Content-Type:\s*application\/http/im.test(segment)) {
      continue;
    }
    parts.push(parseOnePart(segment));
  }
  return parts;
}

function parseOnePart(segment: string): ParsedBatchPart {
  const outerSplit = segment.indexOf("\r\n\r\n");
  if (outerSplit === -1) {
    return { contentId: null, status: null, body: null, parseError: "missing outer header/body separator" };
  }
  const outerHeaders = segment.slice(0, outerSplit);
  const innerHttp = segment.slice(outerSplit + 4);

  const contentIdMatch = /^Content-ID:\s*<(.+?)>\s*$/im.exec(outerHeaders);
  let contentId = contentIdMatch ? contentIdMatch[1]! : null;
  if (contentId?.startsWith(RESPONSE_CONTENT_ID_PREFIX)) {
    contentId = contentId.slice(RESPONSE_CONTENT_ID_PREFIX.length);
  }

  const statusLineEnd = innerHttp.indexOf("\r\n");
  const statusLine = statusLineEnd === -1 ? innerHttp : innerHttp.slice(0, statusLineEnd);
  const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/i.exec(statusLine);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  const innerSplit = innerHttp.indexOf("\r\n\r\n");
  const bodyText = innerSplit === -1 ? "" : innerHttp.slice(innerSplit + 4).trim();

  let body: unknown = null;
  let parseError: string | null = null;
  if (bodyText.length > 0) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      parseError = "non-JSON body in batch part";
    }
  }
  if (contentId === null) {
    parseError = parseError ?? "missing Content-ID in batch part";
  }
  if (status === null) {
    parseError = parseError ?? "missing or unparseable status line in batch part";
  }
  return { contentId, status, body, parseError };
}

export interface SendGmailMessagesBatchOptions {
  fields: string;
  format?: "full" | "metadata" | "minimal";
  /** Overridable for tests; defaults to the real Gmail batch endpoint. */
  batchUrl?: string;
  timeoutMs?: number;
}

/**
 * Sends one outer batch HTTP request for `messageIds.length` inner
 * `messages.get` calls and returns a per-id outcome. Throws
 * `BatchTransportError` only when the WHOLE batch is unusable (network/HTTP
 * failure, unparseable boundary, zero parts found) — a per-id 404/429/5xx is
 * a normal, non-throwing result in `BatchSendResult.failed`.
 */
export async function sendGmailMessagesBatch(
  oauthClient: OAuth2Client,
  messageIds: readonly string[],
  options: SendGmailMessagesBatchOptions
): Promise<BatchSendResult> {
  if (messageIds.length === 0) {
    return { succeeded: new Map(), failed: new Map() };
  }
  const format = options.format ?? "full";
  const boundary = `batch_${randomBytes(12).toString("hex")}`;
  const body = buildBatchRequestBody(messageIds, (id) => messageGetPath(id, format, options.fields), boundary);

  let response: { data: unknown; headers: Record<string, unknown> };
  try {
    response = await oauthClient.request<string>({
      url: options.batchUrl ?? DEFAULT_BATCH_URL,
      method: "POST",
      headers: {
        "Content-Type": `multipart/mixed; boundary=${boundary}`,
        "Accept-Encoding": "gzip",
        "User-Agent": BATCH_USER_AGENT
      },
      data: body,
      responseType: "text",
      timeout: options.timeoutMs ?? 20_000
    });
  } catch (error) {
    throw new BatchTransportError(
      `Gmail batch request failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }

  const contentType = response.headers["content-type"] as string | undefined;
  const responseBoundary = extractBoundary(contentType);
  if (!responseBoundary) {
    throw new BatchTransportError(
      `Gmail batch response had no parseable multipart boundary (content-type: ${contentType ?? "none"}).`
    );
  }
  const rawBody = typeof response.data === "string" ? response.data : String(response.data);
  const parts = parseBatchResponseBody(rawBody, responseBoundary);
  if (parts.length === 0) {
    throw new BatchTransportError("Gmail batch response contained zero parseable parts.");
  }

  const succeeded = new Map<string, unknown>();
  const failed = new Map<string, BatchPartFailure>();
  const seen = new Set<string>();

  for (const part of parts) {
    if (part.contentId === null || seen.has(part.contentId)) {
      // Unattributable (missing or duplicate Content-ID) — reconciled
      // below against the full requested-id list instead of being matched
      // here, since we don't know which requested id this was for.
      continue;
    }
    seen.add(part.contentId);
    if (part.parseError !== null || part.status === null) {
      failed.set(part.contentId, { status: part.status, retryable: true, detail: part.parseError ?? "unparseable batch part" });
    } else if (part.status >= 200 && part.status < 300) {
      succeeded.set(part.contentId, part.body);
    } else if (part.status === 429 || part.status >= 500) {
      failed.set(part.contentId, { status: part.status, retryable: true, detail: `HTTP ${part.status}` });
    } else {
      failed.set(part.contentId, { status: part.status, retryable: false, detail: `HTTP ${part.status}` });
    }
  }

  for (const id of messageIds) {
    if (!succeeded.has(id) && !failed.has(id)) {
      failed.set(id, { status: null, retryable: true, detail: "no matching response part for this id" });
    }
  }

  return { succeeded, failed };
}
