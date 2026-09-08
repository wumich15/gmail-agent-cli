import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import type { GmailClient } from "./client.js";
import { BatchTransportError, sendGmailMessagesBatch, type BatchSendResult } from "./batch.js";
import { fetchMessageFull, fetchMessageMinimal, MESSAGE_FULL_FIELDS } from "./scanner.js";
import { apiErrorStatus, googleApiRateLimiter, isGoogleQuotaError, isRetryableStatus, isRetryableNetworkError, retryAfterMs, type GoogleApiRateLimiter } from "../core/api-retry.js";

/** One batch at a time, with quota reserved for every inner message read. */
export interface BatchHydrationOptions {
  /** Label-only reads for fresh mutation preconditions. */
  format?: "full" | "minimal";
  /** Starting inner-call count. Default 50, hard maximum 50. */
  initialBatchSize?: number;
  maxBatchSize?: number;
  /** Retries per message; earlier failures never consume another message's budget. */
  maxBatchRetryRounds?: number;
  /** Bounded worker pool used when the batch endpoint is unavailable. */
  fallbackConcurrency?: number;
  /** Upper bound for backoff and Retry-After, at most 10 seconds. */
  maxRetryDelayMs?: number;
  rateLimiter?: GoogleApiRateLimiter;
}

export interface BatchHydrationDiagnostics {
  outerBatchRequests: number;
  batchReadAttempts: number;
  fullBatchRequests: number;
  smallestBatch: number;
  largestBatch: number;
  elapsedMs: number;
  batchSucceeded: number;
  batchFailedTerminal: number;
  individualFallback: number;
  retriedMessages: number;
  quotaFailures: number;
  limiterWaitMs: number;
  networkMs: number;
  decodedResponseBytes: number;
}

const HARD_MAX_BATCH_SIZE = 50;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRY_ROUNDS = 2;
const MAX_RETRY_DELAY_MS = 10_000;

function integerOption(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}.`);
  return Math.min(value, maximum);
}

/**
 * Delivers each unique requested ID once. A consumer/persistence error
 * propagates rather than triggering a second callback with null.
 */
export async function hydrateMessagesBatched(
  gmailClient: GmailClient,
  oauthClient: OAuth2Client,
  messageIds: readonly string[],
  onResult: (id: string, message: gmail_v1.Schema$Message | null) => Promise<void> | void,
  options: BatchHydrationOptions = {}
): Promise<BatchHydrationDiagnostics> {
  const maxBatchSize = integerOption(options.maxBatchSize, HARD_MAX_BATCH_SIZE, 1, HARD_MAX_BATCH_SIZE, "maxBatchSize");
  const batchSize = integerOption(options.initialBatchSize, Math.min(DEFAULT_BATCH_SIZE, maxBatchSize), 1, maxBatchSize, "initialBatchSize");
  const maxRetryRounds = integerOption(options.maxBatchRetryRounds, DEFAULT_MAX_RETRY_ROUNDS, 0, 10, "maxBatchRetryRounds");
  const fallbackConcurrency = integerOption(options.fallbackConcurrency, 8, 1, 50, "fallbackConcurrency");
  const maxRetryDelayMs = integerOption(options.maxRetryDelayMs, MAX_RETRY_DELAY_MS, 0, MAX_RETRY_DELAY_MS, "maxRetryDelayMs");
  const limiter = options.rateLimiter ?? googleApiRateLimiter;
  const diagnostics: BatchHydrationDiagnostics = {
    outerBatchRequests: 0, batchReadAttempts: 0, fullBatchRequests: 0, smallestBatch: 0, largestBatch: 0, elapsedMs: 0, batchSucceeded: 0, batchFailedTerminal: 0, individualFallback: 0,
    retriedMessages: 0, quotaFailures: 0, limiterWaitMs: 0, networkMs: 0, decodedResponseBytes: 0
  };
  const startedAt = performance.now();
  const finish = (): BatchHydrationDiagnostics => {
    diagnostics.elapsedMs = performance.now() - startedAt;
    return diagnostics;
  };
  const ids = [...new Set(messageIds)];
  let nextIndex = 0;
  const retries: string[] = [];
  const attempts = new Map<string, number>();

  async function fallback(fallbackIds: readonly string[]): Promise<void> {
    // Settle in-flight callbacks before rejecting so the caller can close SQLite safely.
    let index = 0;
    let stopped = false;
    async function worker(): Promise<void> {
      while (!stopped && index < fallbackIds.length) {
        const id = fallbackIds[index++]!;
        diagnostics.individualFallback += 1;
        let message: gmail_v1.Schema$Message | null;
        try {
          message = await (options.format === "minimal" ? fetchMessageMinimal : fetchMessageFull)(gmailClient, id);
        } catch {
          message = null;
        }
        try {
          await onResult(id, message);
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    }
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(fallbackConcurrency, fallbackIds.length) }, worker));
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  while (nextIndex < ids.length || retries.length > 0) {
    const chunk = retries.splice(0, batchSize);
    const freshCount = Math.min(batchSize - chunk.length, ids.length - nextIndex);
    chunk.push(...ids.slice(nextIndex, nextIndex + freshCount));
    nextIndex += freshCount;
    for (const id of chunk) {
      const previous = attempts.get(id) ?? 0;
      if (previous > 0) diagnostics.retriedMessages += 1;
      attempts.set(id, previous + 1);
    }

    const waitStarted = performance.now();
    await limiter.acquire(chunk.length);
    diagnostics.limiterWaitMs += performance.now() - waitStarted;
    diagnostics.outerBatchRequests += 1;
    diagnostics.batchReadAttempts += chunk.length;
    diagnostics.fullBatchRequests += Number(chunk.length === batchSize);
    diagnostics.smallestBatch = diagnostics.smallestBatch === 0 ? chunk.length : Math.min(diagnostics.smallestBatch, chunk.length);
    diagnostics.largestBatch = Math.max(diagnostics.largestBatch, chunk.length);
    const networkStarted = performance.now();
    let result: BatchSendResult;
    try {
      result = await sendGmailMessagesBatch(oauthClient, chunk, { fields: options.format === "minimal" ? "id,labelIds" : MESSAGE_FULL_FIELDS, format: options.format ?? "full" });
    } catch (error) {
      diagnostics.networkMs += performance.now() - networkStarted;
      if (!(error instanceof BatchTransportError)) throw error;
      if (isGoogleQuotaError(error.cause)) {
        diagnostics.quotaFailures += 1;
        limiter.reportQuotaPressure(Math.min(retryAfterMs(error.cause) ?? MAX_RETRY_DELAY_MS, maxRetryDelayMs));
      } else {
        limiter.reportNetworkError();
      }
      const transient = isGoogleQuotaError(error.cause) || isRetryableStatus(apiErrorStatus(error.cause)) || isRetryableNetworkError(error.cause);
      if (transient) {
        const exhausted = chunk.filter((id) => attempts.get(id)! > maxRetryRounds);
        retries.push(...chunk.filter((id) => attempts.get(id)! <= maxRetryRounds));
        if (!isGoogleQuotaError(error.cause)) {
          const attempt = Math.max(...chunk.map((id) => attempts.get(id)!));
          await new Promise<void>((resolve) => setTimeout(resolve,
            Math.min(retryAfterMs(error.cause) ?? 1000 * 2 ** (attempt - 1), maxRetryDelayMs)));
        }
        if (exhausted.length > 0) await fallback(exhausted);
        continue;
      }
      // Structural/auth/unsupported failures cannot be repaired by retrying
      // the same envelope. Only these disable batching for the remaining run.
      await fallback([...chunk, ...retries, ...ids.slice(nextIndex)]);
      return finish();
    }
    diagnostics.networkMs += performance.now() - networkStarted;
    diagnostics.decodedResponseBytes += result.decodedResponseBytes;

    const failures = [...result.failed.values()];
    const quotaFailures = failures.filter((failure) => failure.quotaPressure);
    const retryableFailures = failures.filter((failure) => failure.retryable);
    let retryDelayMs = 0;
    if (retryableFailures.length > 0) {
      const retryAttempt = Math.max(...chunk.filter((id) => result.failed.get(id)?.retryable).map((id) => attempts.get(id)!));
      const exponential = Math.min(1000 * 2 ** (retryAttempt - 1), maxRetryDelayMs);
      retryDelayMs = Math.min(maxRetryDelayMs, Math.max(exponential + Math.floor(Math.random() * 250),
        ...retryableFailures.map((failure) => failure.retryAfterMs ?? 0)));
    }
    if (quotaFailures.length > 0) {
      diagnostics.quotaFailures += quotaFailures.length;
      limiter.reportQuotaPressure(Math.max(retryDelayMs, Math.min(MAX_RETRY_DELAY_MS, maxRetryDelayMs)));
      // Control quota pressure through admission timing, never permanently
      // shrink transport batches. Retry IDs are topped up with fresh work.
    } else if (failures.length === 0) {
      limiter.reportSuccess(result.succeeded.size);
    } else {
      limiter.reportNetworkError();
    }

    for (const [id, body] of result.succeeded) {
      diagnostics.batchSucceeded += 1;
      await onResult(id, body as gmail_v1.Schema$Message);
    }
    const exhausted: string[] = [];
    for (const [id, failure] of result.failed) {
      if (!failure.retryable) {
        diagnostics.batchFailedTerminal += 1;
        await onResult(id, null);
      } else if (attempts.get(id)! <= maxRetryRounds) {
        retries.push(id);
      } else {
        exhausted.push(id);
      }
    }
    // Quota cooldown is shared via the limiter. Other transient failures
    // still need bounded backoff without lowering the account's quota pace.
    if (retryDelayMs > 0 && quotaFailures.length === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
    if (exhausted.length > 0) await fallback(exhausted);
  }
  return finish();
}

/** Content-free transport summary, shared by cache and work. */
export function formatBatchDiagnostics(d: BatchHydrationDiagnostics): string {
  const rate = d.elapsedMs > 0 ? Math.round(d.batchReadAttempts * 60_000 / d.elapsedMs) : 0;
  return `Batch reads: ${d.outerBatchRequests} requests, ${d.smallestBatch}–${d.largestBatch} messages/batch ` +
    `(${d.fullBatchRequests} full); ${rate} batch reads/min; ` +
    `${Math.round(d.limiterWaitMs / 1000)}s quota wait, ${Math.round(d.networkMs / 1000)}s network; ` +
    `${d.quotaFailures} quota errors, ${d.individualFallback} individual fallbacks.`;
}
