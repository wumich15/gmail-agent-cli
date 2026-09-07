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
export function isRetryableGoogleQuotaMessage(error: unknown): boolean {
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

export function isRetryableStatus(status: number | undefined): boolean {
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
      const retryAfter = retryAfterMs(error);
      // A provider-controlled Retry-After value must not silently defeat
      // the caller's latency bound. In particular, an erroneous HTTP date
      // hours in the future previously made an otherwise capped retry loop
      // look hung indefinitely.
      await sleep(retryAfter === null ? exponential + jitter : Math.min(retryAfter, maxDelayMs));
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
  private readonly fastestIntervalMs: number;
  private readonly ceilingIntervalMs: number;
  private nextRequestAt = 0;
  private consecutiveSuccesses = 0;

  /**
   * `startRequestsPerSecond` is only where the pacer BEGINS each process —
   * `fastestRequestsPerSecond` (defaulting to the start rate, for full
   * backward compatibility with every existing caller/test) is the true
   * ceiling `reportSuccess` can climb toward over a long-running command.
   * Without this distinction, a conservative starting guess could never be
   * exceeded even after thousands of clean requests in a row, permanently
   * capping throughput at whatever the cold-start guess happened to be
   * regardless of what the account's real quota could sustain — the
   * opposite of "use the API to its fullest."
   */
  constructor(
    startRequestsPerSecond: number,
    ceilingIntervalMs = 4000,
    fastestRequestsPerSecond: number = startRequestsPerSecond
  ) {
    // Defense-in-depth: the only production instantiation below is already
    // guarded by parsePositiveNumber, but a non-positive rate here would
    // silently produce Infinity (rate 0) or a negative interval (a
    // negative rate) and make acquire() either never or always wait
    // incorrectly, so any future call site gets a clear failure instead.
    if (!Number.isFinite(startRequestsPerSecond) || startRequestsPerSecond <= 0) {
      throw new Error(`GoogleApiRateLimiter requires a positive requests-per-second value, got ${startRequestsPerSecond}.`);
    }
    if (!Number.isFinite(fastestRequestsPerSecond) || fastestRequestsPerSecond <= 0) {
      throw new Error(`GoogleApiRateLimiter requires a positive fastest-requests-per-second value, got ${fastestRequestsPerSecond}.`);
    }
    this.intervalMs = 1000 / startRequestsPerSecond;
    // The fastest reachable rate can never be slower than the start rate —
    // "fastest" that's slower than where you begin is a contradiction, so
    // this guards against a mis-ordered call accidentally freezing the
    // pacer at its (slower) starting point forever.
    this.fastestIntervalMs = 1000 / Math.max(fastestRequestsPerSecond, startRequestsPerSecond);
    this.ceilingIntervalMs = ceilingIntervalMs;
  }

  /** Current pacing, for observability (e.g. a --json summary or debug output). */
  get currentRequestsPerSecond(): number {
    return 1000 / this.intervalMs;
  }

  /**
   * `weight` lets a caller whose Gmail quota-unit cost is a multiple of the
   * baseline call (baseline = `messages.get` at 20 units) reserve that many
   * pacing slots instead of one, so the requests/second number this class
   * is configured with keeps meaning "quota units per second," not "HTTP
   * calls per second," even when call sites have very different real costs
   * (e.g. `threads.get` at 40 units is weight 2). Treating every call as
   * equally expensive was a real bug: a run dominated by weight-2 calls
   * could consume real quota units twice as fast as the configured rate
   * assumed, reaching the account's actual per-minute cap despite the
   * pacer reporting a seemingly-safe requests/second figure throughout.
   */
  async acquire(weight = 1): Promise<void> {
    const now = Date.now();
    // Reserve the slot synchronously, before yielding. Multiple callers can
    // enter acquire() in the same event-loop turn; merely updating a
    // last-request timestamp after their sleeps lets all of them observe the
    // same timestamp and wake as one burst. Advancing nextRequestAt here
    // gives every concurrent caller its own globally-spaced slot.
    const requestAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = requestAt + this.intervalMs * weight;
    if (requestAt > now) {
      await sleep(requestAt - now);
    }
  }

  reportQuotaPressure(): void {
    this.intervalMs = Math.min(this.intervalMs * 2, this.ceilingIntervalMs);
    this.consecutiveSuccesses = 0;
  }

  reportSuccess(): void {
    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses >= 25 && this.intervalMs > this.fastestIntervalMs) {
      this.intervalMs = Math.max(this.fastestIntervalMs, this.intervalMs * 0.85);
      this.consecutiveSuccesses = 0;
    }
  }

  /**
   * A low-level connection failure (ECONNRESET etc.) isn't a Google quota
   * signal, so it deliberately does NOT trigger reportQuotaPressure's
   * backoff — but it also shouldn't silently count for nothing. Without
   * this, a stretch of network hiccups was excluded from the adaptive
   * feedback loop entirely: neither slowing down (right, since it's not a
   * quota problem) nor allowed to keep contributing to the
   * consecutive-success recovery streak (wrong, since a request that
   * failed to even complete didn't succeed either). Resetting the streak
   * here only delays the next speed-up, never forces a slow-down.
   */
  reportNetworkError(): void {
    this.consecutiveSuccesses = 0;
  }
}

/**
 * Grounded in Gmail API's currently-published per-user quota rather than a
 * guess: Google enforces 6,000 quota units per minute per user per project
 * (https://developers.google.com/workspace/gmail/api/reference/quota),
 * i.e. a 100 units/second sustained average. `messages.get` (20 units) is
 * the baseline this "requests/second" number is calibrated against —
 * `withGoogleApiRetry`'s `weight` parameter scales the pacing interval for
 * calls that cost a different amount, most notably `threads.get` (40
 * units = weight 2) — so these two constants can be read directly as
 * "baseline-equivalent calls per second," not raw HTTP calls per second.
 *
 * **Correcting an earlier version of this comment/these numbers**: a prior
 * pass set FASTEST to 12, i.e. 12 * 20 = 240 real units/second — more than
 * double the 100 units/second cap above — because at the time `threads.get`
 * was priced into the "typical run" assumption but never actually weighted
 * in the pacer itself, so nothing stopped the adaptive recovery climb from
 * quietly blowing past the account's real budget on any run with a lot of
 * trash-bound mail (each triggering a `threads.get`). That combination —
 * an unweighted double-cost call plus a ceiling already over budget on its
 * own — is what produced real "Quota exceeded ... Units per minute per
 * user" errors in production. With `threads.get` now correctly weighted,
 * FASTEST=10 (200 units/second) is appropriate for projects that retained
 * Gmail's legacy, more permissive quota tier. Newer projects can receive the
 * published 100-units/second limit; those projects are detected by the first
 * quota-shaped response and immediately back off through `reportQuotaPressure`
 * instead of failing the entire cache run. The explicit
 * `GMAIL_AGENT_RATE_LIMIT_RPS` override remains available when a project has
 * a known custom quota.
 *
 * Google also changed these unit costs and limits on 2026-05-01; a project
 * that was already using the Gmail API before then keeps its older, more
 * permissive quota "for now" (the legacy tier is substantially faster than
 * the new 6,000-units/minute tier). Since which regime applies to any given
 * account can't be known from inside this process, these defaults allow the
 * legacy tier to reach 200 units/second while a stricter project feeds back a
 * quota response and is paced down automatically. `GMAIL_AGENT_RATE_LIMIT_RPS`
 * remains available when a project has a known custom quota. FASTEST_REQUESTS_PER_SECOND is how far a
 * long-running command (most concretely `gmail cache`'s thousand-plus-
 * message snapshot) is allowed to ramp up to if sustained clean requests
 * suggest the account can sustain it (15% steps every 25 consecutive clean
 * requests), abandoned immediately on the first real quota-shaped failure.
 */
// Start above the old conservative 80-units/second cap, then ramp to
// 200-units/second (10 messages.get-equivalents/sec) on a clean run. A newer
// 6,000-units/minute project will feed back a quota response and be paced down
// automatically; an older project can use its available headroom immediately.
const START_REQUESTS_PER_SECOND = 5;
const FASTEST_REQUESTS_PER_SECOND = 10;
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
 * project's real per-user quota is higher or lower than the default (this
 * also becomes the fastest rate reached on this override path, matching
 * the explicit value the user gave rather than second-guessing it with a
 * separate ceiling).
 */
export const googleApiRateLimiter = new GoogleApiRateLimiter(
  process.env["VITEST"] !== undefined
    ? TEST_ENV_REQUESTS_PER_SECOND
    : parsePositiveNumber(process.env["GMAIL_AGENT_RATE_LIMIT_RPS"], START_REQUESTS_PER_SECOND),
  4000,
  process.env["VITEST"] !== undefined
    ? TEST_ENV_REQUESTS_PER_SECOND
    : parsePositiveNumber(process.env["GMAIL_AGENT_RATE_LIMIT_RPS"], FASTEST_REQUESTS_PER_SECOND)
);

/**
 * `withApiRetry`, but for Gmail/Calendar calls specifically: paces every
 * attempt (including retries) through the shared `googleApiRateLimiter`
 * first, and feeds that limiter's adaptive backoff from whether each
 * attempt hit a retryable (quota-shaped) failure or not.
 *
 * `weight` is this call's Gmail quota-unit cost relative to the baseline
 * `messages.get` (20 units = weight 1) the limiter's requests/second
 * default is calibrated against — pass 2 for `threads.get` (40 units); every
 * other call site already defaults to 1, which undercounts a handful of
 * cheaper calls (`labels.list`/`history.list` at 1-2 units) and a few
 * pricier ones (`batchModify` at 50 units, `messages.send` at 100), but
 * those are either rare (once per same-mutation group, not per message) or
 * already cheap enough that leaving them at the conservative default of 1
 * doesn't risk exceeding quota — unlike `threads.get`, which fires once per
 * *every* message about to be trashed and was therefore the one omission
 * that could actually double a typical run's real unit cost.
 */
export async function withGoogleApiRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}, weight = 1): Promise<T> {
  return withApiRetry(async () => {
    await googleApiRateLimiter.acquire(weight);
    try {
      const result = await fn();
      googleApiRateLimiter.reportSuccess();
      return result;
    } catch (error) {
      // 5xx responses remain retryable in withApiRetry, but they indicate a
      // provider outage rather than quota pressure. Slowing every later
      // Gmail call after a transient 500/503 only compounds that outage.
      if (apiErrorStatus(error) === 429 || isRetryableGoogleQuotaMessage(error)) {
        googleApiRateLimiter.reportQuotaPressure();
      } else if (isRetryableNetworkError(error)) {
        googleApiRateLimiter.reportNetworkError();
      }
      throw error;
    }
  }, options);
}
