/**
 * Retry/backoff and HTTP-status helpers shared by every outbound API this
 * app calls. Both `gaxios` (which Gmail/Calendar via `googleapis` surface
 * errors as) and the `openai` SDK expose the same shape on failure: a
 * numeric `.status` and a fetch-like `.response.headers` with `.get()`.
 * Note: `.code` is *not* the HTTP status on either SDK — gaxios only sets
 * it for low-level network errors (e.g. `ECONNRESET`); the real status of
 * a response, including 404/409/429, lives on `.status`. `.code` is used
 * below only as the *network-error* retry signal, never as a status.
 */

export function apiErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Low-level connection failures below the HTTP layer entirely — no
 * response, so no `.status` — which `isRetryableStatus` alone would never
 * catch. These are exactly as transient as a 503, and the module's own
 * doc comment already treats `.code` as the low-level-network-error
 * signal, so it's used here (never as a stand-in for HTTP status).
 */
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE"
]);

function isRetryableNetworkError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_NETWORK_ERROR_CODES.has(code);
}

/**
 * Google's Service Infrastructure quota errors ("Quota exceeded for quota
 * metric '...' and limit '...' of service '...'") don't always carry a
 * `.status` this client library layer preserves — in practice they've been
 * observed reaching here as a bare `Error` with no numeric `.status` at
 * all, meaning `isRetryableStatus` alone misses them entirely and they
 * fail immediately with zero retries despite being exactly as transient as
 * a 429. Only a per-second/per-minute/per-100-seconds bucket is treated as
 * retryable here — a daily/lifetime quota error matching the same message
 * shape would never clear within this process's retry budget, so retrying
 * it would just waste the budget before falling through to the same
 * failure anyway.
 */
function isRetryableGoogleQuotaMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Quota exceeded for quota metric/i.test(message) && /per (second|minute|100 seconds)/i.test(message);
}

/** Parses RFC 7231 `Retry-After` in either its delta-seconds or HTTP-date form. */
function retryAfterMs(error: unknown): number | null {
  const headers = (error as { response?: { headers?: unknown } } | undefined)?.response?.headers;
  if (!headers || typeof (headers as { get?: unknown }).get !== "function") {
    return null;
  }
  const raw = (headers as { get: (name: string) => string | null }).get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * `maxAttempts: 5` only ever accumulates ~15s of total backoff (1+2+4+8s
 * across the 4 waits before the 5th and final attempt throws immediately)
 * — nowhere near enough for a Gmail "Units per minute per user" quota
 * error to actually clear, since that bucket is refilled on roughly a
 * one-minute cadence. `maxAttempts: 7` accumulates ~61s (1+2+4+8+16+30s
 * across 6 waits), comfortably spanning a full minute so a genuinely
 * transient per-minute quota exhaustion has a real chance of clearing
 * within one call's retry budget instead of failing the whole command.
 */
const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 7,
  baseDelayMs: 1000,
  maxDelayMs: 30_000
};

/**
 * Retries an API call with truncated exponential backoff and jitter on
 * 429 (rate limit / quota exceeded) and 5xx responses, a Google
 * per-second/per-minute quota-exceeded error regardless of its `.status`
 * (see `isRetryableGoogleQuotaMessage`), and select low-level network
 * errors, honoring `Retry-After` when the server sends one. Every other
 * error (4xx auth/permission/not-found failures, or a daily/lifetime
 * quota error that won't clear within this process's lifetime) is not
 * worth retrying. Works for Google (Gmail/Calendar) and OpenAI calls
 * alike — see the module doc for why the same status-based logic applies
 * to both.
 */
export async function withApiRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_OPTIONS, ...options };
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const status = apiErrorStatus(error);
      const retryable = isRetryableStatus(status) || isRetryableNetworkError(error) || isRetryableGoogleQuotaMessage(error);
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }
      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = exponential * 0.25 * Math.random();
      await sleep(retryAfterMs(error) ?? exponential + jitter);
    }
  }
}

/**
 * Adaptive, process-wide pacing for Gmail/Calendar calls specifically
 * (never OpenAI — a separate rate-limit domain with its own budget in
 * `OpenAiClassifier`). Rather than guessing a single "safe" requests/second
 * number up front (real observed per-project quotas have turned out lower
 * than Google's documented defaults), this starts at a moderate rate,
 * halves it the moment it sees a quota-shaped failure, and only creeps
 * back up after a sustained clean streak — the goal named directly:
 * "use the API to its fullest without getting rate limited," found
 * adaptively rather than hardcoded.
 */
export class GoogleApiRateLimiter {
  private intervalMs: number;
  private readonly floorIntervalMs: number;
  private readonly ceilingIntervalMs: number;
  private lastRequestAt = 0;
  private consecutiveSuccesses = 0;

  constructor(initialRequestsPerSecond: number, ceilingIntervalMs = 4000) {
    this.intervalMs = 1000 / initialRequestsPerSecond;
    this.floorIntervalMs = this.intervalMs;
    this.ceilingIntervalMs = ceilingIntervalMs;
  }

  /** Current pacing, for observability (e.g. a --json summary or debug output). */
  get currentRequestsPerSecond(): number {
    return 1000 / this.intervalMs;
  }

  async acquire(): Promise<void> {
    const waitUntil = this.lastRequestAt + this.intervalMs;
    const now = Date.now();
    if (waitUntil > now) {
      await sleep(waitUntil - now);
    }
    this.lastRequestAt = Date.now();
  }

  reportQuotaPressure(): void {
    this.intervalMs = Math.min(this.intervalMs * 2, this.ceilingIntervalMs);
    this.consecutiveSuccesses = 0;
  }

  reportSuccess(): void {
    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses >= 25 && this.intervalMs > this.floorIntervalMs) {
      this.intervalMs = Math.max(this.floorIntervalMs, this.intervalMs * 0.85);
      this.consecutiveSuccesses = 0;
    }
  }
}

const DEFAULT_GOOGLE_REQUESTS_PER_SECOND = 8;
// Effectively unlimited: real production pacing has no place slowing down
// a test suite that constructs dozens of fake-client calls per test and
// never talks to a real Gmail API. Vitest sets this env var in every
// worker automatically, so this needs no test-file-by-test-file opt-out.
const TEST_ENV_REQUESTS_PER_SECOND = 1_000_000;

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * One shared limiter for the whole process — concurrent Gmail reads
 * (`mapWithConcurrency`) all pace through the same instance, so raising
 * `concurrency.gmailReads` increases parallelism without increasing the
 * actual request rate beyond what this limiter allows. Override the
 * starting rate with `GMAIL_AGENT_RATE_LIMIT_RPS` if you know your
 * project's real per-user quota is higher or lower than the default.
 */
export const googleApiRateLimiter = new GoogleApiRateLimiter(
  process.env["VITEST"] !== undefined
    ? TEST_ENV_REQUESTS_PER_SECOND
    : parsePositiveNumber(process.env["GMAIL_AGENT_RATE_LIMIT_RPS"], DEFAULT_GOOGLE_REQUESTS_PER_SECOND)
);

/**
 * `withApiRetry`, but for Gmail/Calendar calls specifically: paces every
 * attempt (including retries) through the shared `googleApiRateLimiter`
 * first, and feeds that limiter's adaptive backoff from whether each
 * attempt hit a retryable (quota-shaped) failure or not.
 */
export async function withGoogleApiRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  return withApiRetry(async () => {
    await googleApiRateLimiter.acquire();
    try {
      const result = await fn();
      googleApiRateLimiter.reportSuccess();
      return result;
    } catch (error) {
      if (isRetryableStatus(apiErrorStatus(error)) || isRetryableGoogleQuotaMessage(error)) {
        googleApiRateLimiter.reportQuotaPressure();
      }
      throw error;
    }
  }, options);
}
