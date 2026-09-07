import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import type { GmailClient } from "./client.js";
import { BatchTransportError, sendGmailMessagesBatch } from "./batch.js";
import { fetchMessageFull, MESSAGE_FULL_FIELDS } from "./scanner.js";
import { apiErrorStatus, googleApiRateLimiter, isRetryableGoogleQuotaMessage, type GoogleApiRateLimiter } from "../core/api-retry.js";

/**
 * Quota-aware driver for the batch transport (CLAUDE.md's "Planned Gmail
 * read-transport optimization", step 4). `batch.ts` only knows how to send
 * one outer batch and report per-part outcomes; this module owns the
 * policy: shrinking batch size under quota pressure, retrying only
 * retryable failed parts (never re-sending succeeded ones or the whole
 * batch), bounding total retry rounds so hydration always terminates, and
 * falling back to individual `fetchMessageFull` reads whenever batching
 * itself can't make progress.
 *
 * Ships opt-in only (see `commands/cache.ts`'s `GMAIL_AGENT_BATCH_HYDRATION`
 * check) — CLAUDE.md's acceptance gate requires a live-account benchmark
 * proving a wall-clock/request-count improvement with no higher 429 rate
 * before this can default on, which this sandboxed environment cannot run.
 */

export interface BatchHydrationOptions {
  /** Inner `messages.get` calls per outer batch to start at. Default 25, per CLAUDE.md. */
  initialBatchSize?: number;
  /** Hard ceiling regardless of `initialBatchSize` — CLAUDE.md caps this at 50 even though Gmail's protocol allows up to 100. */
  maxBatchSize?: number;
  /** Total batch-retry rounds allowed across the whole hydration run before remaining retryable failures fall back to individual reads. */
  maxBatchRetryRounds?: number;
  /** Injectable for tests; defaults to the real shared, process-wide limiter. */
  rateLimiter?: GoogleApiRateLimiter;
}

export interface BatchHydrationDiagnostics {
  outerBatchRequests: number;
  batchSucceeded: number;
  batchFailedTerminal: number;
  /** Messages hydrated one-by-one because batching failed or was exhausted for them — never counted as a batch failure against precision gates, since the message still gets hydrated. */
  individualFallback: number;
}

const HARD_MAX_BATCH_SIZE = 50;
const MIN_BATCH_SIZE = 5;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_RETRY_ROUNDS = 2;

function emptyDiagnostics(): BatchHydrationDiagnostics {
  return { outerBatchRequests: 0, batchSucceeded: 0, batchFailedTerminal: 0, individualFallback: 0 };
}

function isQuotaShapedTransportError(error: unknown): boolean {
  if (!(error instanceof BatchTransportError)) return false;
  return (
    apiErrorStatus(error.cause) === 429 || isRetryableGoogleQuotaMessage(error.cause) || isRetryableGoogleQuotaMessage(error)
  );
}

async function hydrateOneIndividually(
  gmailClient: GmailClient,
  id: string,
  onResult: (id: string, message: gmail_v1.Schema$Message | null) => Promise<void> | void
): Promise<void> {
  try {
    const message = await fetchMessageFull(gmailClient, id);
    await onResult(id, message);
  } catch {
    await onResult(id, null);
  }
}

/**
 * Hydrates every id in `messageIds` via batched `messages.get` reads,
 * calling `onResult` exactly once per id (never zero, never twice) with
 * either the decoded message or `null` on unrecoverable failure — the same
 * contract callers already rely on from a plain `fetchMessageFull` loop.
 */
export async function hydrateMessagesBatched(
  gmailClient: GmailClient,
  oauthClient: OAuth2Client,
  messageIds: readonly string[],
  onResult: (id: string, message: gmail_v1.Schema$Message | null) => Promise<void> | void,
  options: BatchHydrationOptions = {}
): Promise<BatchHydrationDiagnostics> {
  const maxBatchSize = Math.min(options.maxBatchSize ?? HARD_MAX_BATCH_SIZE, HARD_MAX_BATCH_SIZE);
  let batchSize = Math.max(MIN_BATCH_SIZE, Math.min(options.initialBatchSize ?? DEFAULT_BATCH_SIZE, maxBatchSize));
  const maxRetryRounds = options.maxBatchRetryRounds ?? DEFAULT_MAX_RETRY_ROUNDS;
  const limiter = options.rateLimiter ?? googleApiRateLimiter;

  const diagnostics = emptyDiagnostics();
  let remaining = [...messageIds];
  let retryRoundsUsed = 0;

  while (remaining.length > 0) {
    const chunkSize = Math.max(MIN_BATCH_SIZE, Math.min(batchSize, maxBatchSize, remaining.length));
    const chunk = remaining.slice(0, chunkSize);
    remaining = remaining.slice(chunkSize);

    try {
      // Reserve quota for every inner call before sending — an outer batch
      // must never be accounted as one cheap request (CLAUDE.md step 4).
      await limiter.acquire(chunk.length);
      diagnostics.outerBatchRequests += 1;
      const result = await sendGmailMessagesBatch(oauthClient, chunk, { fields: MESSAGE_FULL_FIELDS, format: "full" });
      limiter.reportSuccess();

      for (const [id, body] of result.succeeded) {
        diagnostics.batchSucceeded += 1;
        await onResult(id, body as gmail_v1.Schema$Message);
      }

      const retryableIds: string[] = [];
      let sawQuotaShapedPartFailure = false;
      for (const [id, failure] of result.failed) {
        if (failure.retryable) {
          retryableIds.push(id);
          if (failure.status === 429) sawQuotaShapedPartFailure = true;
        } else {
          diagnostics.batchFailedTerminal += 1;
          await onResult(id, null);
        }
      }

      if (retryableIds.length === 0) continue;

      if (sawQuotaShapedPartFailure) {
        limiter.reportQuotaPressure();
        batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2.5)); // 25 -> 10 -> 5
      }
      if (retryRoundsUsed < maxRetryRounds) {
        retryRoundsUsed += 1;
        // Retry ahead of untouched work, at the (possibly now-smaller) batch size.
        remaining = [...retryableIds, ...remaining];
      } else {
        for (const id of retryableIds) {
          diagnostics.individualFallback += 1;
          await hydrateOneIndividually(gmailClient, id, onResult);
        }
      }
    } catch (error) {
      // The whole outer request failed structurally — there is no per-part
      // information at all, so every id in this chunk falls back to an
      // individual read without losing any other chunk's already-successful
      // results (CLAUDE.md step 4).
      if (isQuotaShapedTransportError(error)) {
        limiter.reportQuotaPressure();
        batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2.5));
      }
      for (const id of chunk) {
        diagnostics.individualFallback += 1;
        await hydrateOneIndividually(gmailClient, id, onResult);
      }
    }
  }

  return diagnostics;
}
