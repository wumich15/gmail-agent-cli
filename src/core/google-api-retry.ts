/**
 * Retry/backoff and HTTP-status helpers for Google API calls (Gmail and
 * Calendar both go through `googleapis`, which surfaces failures as
 * `gaxios`'s `GaxiosError`). gaxios only sets `.code` for low-level
 * network errors (e.g. `ECONNRESET`) — the HTTP status of a real
 * response, including 404/409/429, lives on `.status`, not `.code`.
 */

export function googleApiErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function retryAfterMs(error: unknown): number | null {
  const headers = (error as { response?: { headers?: unknown } } | undefined)?.response?.headers;
  if (!headers || typeof (headers as { get?: unknown }).get !== "function") {
    return null;
  }
  const raw = (headers as { get: (name: string) => string | null }).get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
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

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000
};

/**
 * Retries a Google API call with truncated exponential backoff and jitter
 * on 429 (rate limit / quota exceeded) and 5xx responses, honoring
 * `Retry-After` when Google sends one. Every other error (4xx auth/
 * permission/not-found failures) is not transient and is never retried.
 */
export async function withGoogleApiRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_OPTIONS, ...options };
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const status = googleApiErrorStatus(error);
      if (!isRetryableStatus(status) || attempt >= maxAttempts) {
        throw error;
      }
      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = exponential * 0.25 * Math.random();
      await sleep(retryAfterMs(error) ?? exponential + jitter);
    }
  }
}
