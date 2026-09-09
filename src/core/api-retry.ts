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
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
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

export function isRetryableNetworkError(error: unknown): boolean {
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

/** Gmail reports transient quota pressure as 403 reasons as well as 429. */
export function isGoogleQuotaError(error: unknown): boolean {
  if (apiErrorStatus(error) === 429 || isRetryableGoogleQuotaMessage(error)) return true;
  if (typeof error !== "object" || error === null) return false;
  const response = (error as { response?: { data?: unknown } }).response;
  const data = response?.data ?? error;
  const body = typeof data === "object" && data !== null
    ? data as { error?: { message?: string; errors?: { reason?: string }[] }; message?: string; errors?: { reason?: string }[] }
    : undefined;
  const reasons = body?.error?.errors ?? body?.errors ?? [];
  return isRetryableGoogleQuotaMessage(body?.error?.message ?? body?.message) || reasons.some(({ reason }) => reason === "rateLimitExceeded" || reason === "userRateLimitExceeded");
}

/** Parses RFC 7231 `Retry-After` in either its delta-seconds or HTTP-date form. */
export function retryAfterMs(error: unknown): number | null {
  const headers = (error as { response?: { headers?: unknown } } | undefined)?.response?.headers;
  if (!headers || typeof headers !== "object") return null;
  const rawValue = typeof (headers as { get?: unknown }).get === "function"
    ? (headers as { get: (name: string) => string | null }).get("retry-after")
    : Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  const raw = typeof rawValue === "string" || typeof rawValue === "number" ? String(rawValue) : null;
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
      const retryable = isRetryableStatus(status) || isRetryableNetworkError(error) || isGoogleQuotaError(error);
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
      await sleep(retryAfter === null ? Math.min(exponential + jitter, maxDelayMs) : Math.min(retryAfter, maxDelayMs));
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
  private readonly burstCapacity: number;
  /**
   * Token bucket, in baseline-request units, refilling at one token per
   * `intervalMs`. Allowed to go negative so a heavy call (weight 2) still
   * admits immediately and then repays its cost, which is what the old
   * `nextRequestAt = now + intervalMs * weight` reservation did.
   */
  private tokens: number;
  private tokensUpdatedAt = Date.now();
  private consecutiveSuccesses = 0;
  private cooldownUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly quotaWaitListeners = new Set<(waitMs: number) => void>();
  private waitMs = 0;
  private readonly recentAdmissions: { at: number; weight: number }[] = [];

  get quotaCooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  get totalWaitMs(): number { return this.waitMs; }

  subscribeQuotaWait(listener: (waitMs: number) => void): () => void {
    this.quotaWaitListeners.add(listener);
    return () => { this.quotaWaitListeners.delete(listener); };
  }

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
   *
   * `burstCapacity` is how many baseline requests may be admitted back to
   * back before the pace applies at all, in the same weight units as
   * `acquire`. It defaults to 1 — strict even spacing, the behavior existing
   * callers and tests rely on — but production passes the full rolling
   * minute budget, because Gmail's quota really is a per-minute bucket and
   * not a per-request metronome. Spacing 100 reads 218ms apart spent ~22
   * seconds of pure admission latency on a `--limit 100` run while the
   * account's minute budget sat almost entirely unused; with a bucket that
   * deep the same run spends its allowance immediately and waits only once
   * the rolling window (still enforced in `acquire`, and still the hard cap)
   * is genuinely full.
   */
  constructor(
    startRequestsPerSecond: number,
    ceilingIntervalMs = 4000,
    fastestRequestsPerSecond: number = startRequestsPerSecond,
    private readonly minuteBudget: number = Infinity,
    burstCapacity = 1
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
    this.burstCapacity = Math.max(1, burstCapacity);
    this.tokens = this.burstCapacity;
  }

  /** Credits elapsed time to the bucket at the pace in force for that stretch. */
  private refill(now: number): void {
    if (now <= this.tokensUpdatedAt) return;
    this.tokens = Math.min(this.burstCapacity, this.tokens + (now - this.tokensUpdatedAt) / this.intervalMs);
    this.tokensUpdatedAt = now;
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
    if (!Number.isFinite(weight) || weight <= 0 || weight > this.minuteBudget) throw new Error("Quota weight must be positive and finite.");
    const startedAt = Date.now();
    // Serialize admission, not HTTP work. Queued workers recheck the shared
    // cooldown and current pace instead of retaining stale pre-error slots.
    const admission = this.queue.then(async () => {
      for (;;) {
        const now = Date.now();
        while (this.recentAdmissions[0] && this.recentAdmissions[0].at <= now - 60_000) this.recentAdmissions.shift();
        let used = this.recentAdmissions.reduce((sum, entry) => sum + entry.weight, 0);
        let budgetAvailableAt = now;
        for (const entry of this.recentAdmissions) {
          if (used + weight <= this.minuteBudget + 1e-9) break;
          budgetAvailableAt = entry.at + 60_000;
          used -= entry.weight;
        }
        this.refill(now);
        // One whole token admits a request of any size; a heavier call then
        // repays the difference as debt, so weight still costs full pace.
        const needed = Math.min(weight, 1);
        const paceWait = this.tokens >= needed ? 0 : Math.ceil((needed - this.tokens) * this.intervalMs);
        const wait = Math.max(paceWait, this.cooldownUntil - now, budgetAvailableAt - now);
        if (wait <= 0) break;
        await sleep(wait);
      }
      if (Number.isFinite(this.minuteBudget)) this.recentAdmissions.push({ at: Date.now(), weight });
      this.tokens -= weight;
      this.waitMs += Date.now() - startedAt;
    });
    this.queue = admission.catch(() => {});
    await admission;
  }

  /** Failures from requests admitted at the old pace are one pressure wave. */
  reportQuotaPressureForAttempt(requestRate: number, cooldownMs: number): void {
    if (requestRate <= this.currentRequestsPerSecond) {
      this.reportQuotaPressure(cooldownMs);
    } else if (cooldownMs > this.quotaCooldownRemainingMs) {
      // Still honor a real server Retry-After, without halving once per worker.
      this.cooldownUntil = Date.now() + Math.min(cooldownMs, 60_000);
      for (const listener of this.quotaWaitListeners) listener(this.quotaCooldownRemainingMs);
    }
  }

  /**
   * A named per-minute rejection means the current rolling quota window is
   * already full; it does not prove that our sustainable configured pace is
   * too high. This commonly happens when a cache run starts less than a
   * minute after another CLI process consumed quota. Hold all queued work
   * until that external window can clear without permanently ratcheting the
   * process down to the 0.25 req/s floor.
   */
  pauseForQuotaWindow(cooldownMs: number): void {
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return;
    const now = Date.now();
    this.consecutiveSuccesses = 0;
    // Treat failures from requests already in flight as one pressure wave;
    // they must not keep extending the same one-minute pause.
    if (this.cooldownUntil > now) return;
    this.cooldownUntil = now + Math.min(cooldownMs, 60_000);
    for (const listener of this.quotaWaitListeners) listener(this.quotaCooldownRemainingMs);
  }

  reportQuotaPressure(cooldownMs = 0): void {
    const now = Date.now();
    // All failures in one in-flight wave share one slowdown. Repeatedly
    // halving for each worker used to drive an eight-worker pool to a crawl.
    if (cooldownMs > 0 && this.cooldownUntil > now) return;
    this.refill(now);
    this.intervalMs = Math.min(this.intervalMs * 2, this.ceilingIntervalMs);
    // Drop the accumulated burst too. Halving the refill rate while a full
    // bucket is still sitting there would let the next wave go out at
    // exactly the pace that just drew a quota error. One token is left so
    // this only removes the burst; it never adds a new penalty wait.
    this.tokens = Math.min(this.tokens, 1);
    this.consecutiveSuccesses = 0;
    if (cooldownMs > 0) {
      this.cooldownUntil = now + Math.min(cooldownMs, 60_000);
      for (const listener of this.quotaWaitListeners) listener(this.quotaCooldownRemainingMs);
    }
  }

  reportSuccess(weight = 1): void {
    if (this.quotaCooldownRemainingMs > 0) return;
    this.consecutiveSuccesses += weight;
    // Count inner messages, not envelopes: 50 successful reads earn the
    // same recovery as fifty individual successes (two 25-read steps).
    const recoverySteps = Math.floor(this.consecutiveSuccesses / 25);
    if (recoverySteps > 0) {
      this.refill(Date.now());
      this.intervalMs = Math.max(this.fastestIntervalMs, this.intervalMs * 0.85 ** recoverySteps);
      this.consecutiveSuccesses %= 25;
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
 * Gmail's current quota is 6,000 units/minute/user/project; messages.get
 * costs 20, so 300 reads/minute is the theoretical ceiling with zero
 * headroom. Target 275/minute instead (per explicit product decision):
 * the rolling weighted budget also charges auxiliary reads (list/history/
 * labels/profile) and retries against the same minute, so pacing right at
 * 300 means the very first auxiliary call of a minute already exceeds the
 * account's real budget. 275 leaves ~500 quota units/minute of headroom for
 * that traffic without a separate, harder-to-reason-about accounting path.
 * Legacy/custom projects can explicitly set GMAIL_AGENT_RATE_LIMIT_RPS to
 * use their verified higher budget.
 * https://developers.google.com/workspace/gmail/api/reference/quota
 */
const START_REQUESTS_PER_SECOND = 275 / 60;
const FASTEST_REQUESTS_PER_SECOND = 275 / 60;
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
const IS_TEST_ENV = process.env["VITEST"] !== undefined;
const CONFIGURED_START_RPS = IS_TEST_ENV
  ? TEST_ENV_REQUESTS_PER_SECOND
  : parsePositiveNumber(process.env["GMAIL_AGENT_RATE_LIMIT_RPS"], START_REQUESTS_PER_SECOND);
const CONFIGURED_FASTEST_RPS = IS_TEST_ENV
  ? TEST_ENV_REQUESTS_PER_SECOND
  : parsePositiveNumber(process.env["GMAIL_AGENT_RATE_LIMIT_RPS"], FASTEST_REQUESTS_PER_SECOND);
const CONFIGURED_MINUTE_BUDGET = IS_TEST_ENV ? Infinity : Math.max(275, CONFIGURED_FASTEST_RPS * 60);

export const googleApiRateLimiter = new GoogleApiRateLimiter(
  CONFIGURED_START_RPS,
  4000,
  CONFIGURED_FASTEST_RPS,
  CONFIGURED_MINUTE_BUDGET,
  // The whole minute's allowance is spendable at once. The rolling window
  // above still caps real consumption at the same 275 units/minute, so this
  // changes only *when* a run is allowed to spend them: immediately, the way
  // a per-minute quota actually works, rather than one read every 218ms.
  IS_TEST_ENV ? 1 : CONFIGURED_MINUTE_BUDGET
);

/**
 * `withApiRetry`, but for Gmail/Calendar calls specifically: paces every
 * attempt (including retries) through the shared `googleApiRateLimiter`
 * first, and feeds that limiter's adaptive backoff from whether the first
 * attempt of the logical request hit a retryable (quota-shaped) failure or
 * not. Retries share that request's pressure signal.
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
export interface GoogleApiAttemptEvent {
  requestId: number;
  attempt: number;
  operation: string;
  stage: "queued" | "started" | "succeeded" | "failed";
  quotaWeight: number;
  limiterWaitMs?: number;
  networkMs?: number;
  status?: number;
  errorClass?: "quota" | "network" | "http" | "unknown";
  quotaReason?: "concurrent_requests" | "per_minute" | "bandwidth" | "rate_limit";
  requestsPerSecond: number;
}
function quotaReason(error: unknown): NonNullable<GoogleApiAttemptEvent["quotaReason"]> {
  const value = error as { message?: string; response?: { data?: { error?: { message?: string } } } } | undefined;
  const message = value?.response?.data?.error?.message ?? value?.message ?? "";
  if (/concurrent/i.test(message)) return "concurrent_requests";
  if (/per minute/i.test(message)) return "per_minute";
  if (/bandwidth/i.test(message)) return "bandwidth";
  return "rate_limit";
}
const PER_MINUTE_QUOTA_WINDOW_MS = 60_000;
const attemptListeners = new Set<(event: GoogleApiAttemptEvent) => void>();
let nextRequestId = 0;
export function subscribeGoogleApiAttempts(listener: (event: GoogleApiAttemptEvent) => void): () => void {
  attemptListeners.add(listener);
  return () => { attemptListeners.delete(listener); };
}
function emitAttempt(event: GoogleApiAttemptEvent): void {
  for (const listener of attemptListeners) listener(event);
}

export async function withGoogleApiRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}, weight = 1, operation = "google.api"): Promise<T> {
  const requestId = ++nextRequestId;
  let attempt = 0;
  return withApiRetry(async () => {
    const queuedAt = performance.now();
    const base = { requestId, attempt: ++attempt, operation, quotaWeight: weight };
    emitAttempt({ ...base, stage: "queued", requestsPerSecond: googleApiRateLimiter.currentRequestsPerSecond });
    await googleApiRateLimiter.acquire(weight);
    const networkStartedAt = performance.now();
    const limiterWaitMs = Math.round(networkStartedAt - queuedAt);
    emitAttempt({ ...base, stage: "started", limiterWaitMs, requestsPerSecond: googleApiRateLimiter.currentRequestsPerSecond });
    const admittedRate = googleApiRateLimiter.currentRequestsPerSecond;
    try {
      const result = await fn();
      googleApiRateLimiter.reportSuccess(weight);
      emitAttempt({ ...base, stage: "succeeded", limiterWaitMs, networkMs: Math.round(performance.now() - networkStartedAt), requestsPerSecond: googleApiRateLimiter.currentRequestsPerSecond });
      return result;
    } catch (error) {
      const status = apiErrorStatus(error);
      const detectedQuotaReason = isGoogleQuotaError(error) ? quotaReason(error) : undefined;
      emitAttempt({ ...base, stage: "failed", limiterWaitMs, networkMs: Math.round(performance.now() - networkStartedAt),
        ...(status !== undefined ? { status } : {}),
        ...(detectedQuotaReason !== undefined ? { quotaReason: detectedQuotaReason } : {}),
        errorClass: detectedQuotaReason !== undefined ? "quota" : isRetryableNetworkError(error) ? "network" : status !== undefined ? "http" : "unknown",
        requestsPerSecond: googleApiRateLimiter.currentRequestsPerSecond });
      // 5xx responses remain retryable in withApiRetry, but they indicate a
      // provider outage rather than quota pressure. Slowing every later
      // Gmail call after a transient 500/503 only compounds that outage.
      if (isGoogleQuotaError(error)) {
        // A generic quota error without Retry-After only slows future
        // admissions; the old unconditional flat cooldown stalled all work
        // without knowing which window was full. The one deliberate fallback
        // is an error that explicitly names the per-minute bucket: pausing a
        // full rolling minute is then more accurate than repeatedly halving
        // an otherwise-valid sustained rate.
        const serverRetryAfterMs = retryAfterMs(error);
        const cap = options.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs;
        // Retries belong to the same logical request. Halving the shared
        // limiter once for every retry made one quota incident cascade into
        // 4.58 -> 2.29 -> 1.14 requests/sec and slowed unrelated workers.
        // The first failed attempt is enough to signal this pressure wave;
        // the retry loop itself already waits before trying again.
        if (attempt === 1) {
          if (detectedQuotaReason === "per_minute") {
            // A prior CLI process or another consumer can have filled the
            // provider's rolling window even though this process is pacing
            // below 6,000 units/minute. Wait out that window as a group;
            // halving once per newly admitted request caused the observed
            // 4.58 -> 0.25 req/s cache crawl after only ~100 messages.
            googleApiRateLimiter.pauseForQuotaWindow(
              serverRetryAfterMs !== null ? Math.min(serverRetryAfterMs, cap) : PER_MINUTE_QUOTA_WINDOW_MS
            );
          } else {
            googleApiRateLimiter.reportQuotaPressureForAttempt(
              admittedRate,
              serverRetryAfterMs !== null ? Math.min(serverRetryAfterMs, cap) : 0
            );
          }
        }
      } else {
        googleApiRateLimiter.reportNetworkError();
      }
      throw error;
    }
  }, options);
}
