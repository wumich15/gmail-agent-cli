/**
 * Retry/backoff and HTTP-status helpers shared by every outbound API this
 * app calls. Both `gaxios` (which Gmail/Calendar via `googleapis` surface
 * errors as) and the `openai` SDK expose the same shape on failure: a
 * numeric `.status` and a fetch-like `.response.headers` with `.get()`.
 * Note: `.code` is *not* the HTTP status on either SDK — gaxios only sets
 * it for low-level network errors (e.g. `ECONNRESET`); the real status of
 * a response, including 404/409/429, lives on `.status`.
 */

export function apiErrorStatus(error: unknown): number | undefined {
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
 * Retries an API call with truncated exponential backoff and jitter on
 * 429 (rate limit / quota exceeded) and 5xx responses, honoring
 * `Retry-After` when the server sends one. Every other error (4xx auth/
 * permission/not-found failures) is not transient and is never retried.
 * Works for Google (Gmail/Calendar) and OpenAI calls alike — see the
 * module doc for why the same status-based logic applies to both.
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
      if (!isRetryableStatus(status) || attempt >= maxAttempts) {
        throw error;
      }
      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = exponential * 0.25 * Math.random();
      await sleep(retryAfterMs(error) ?? exponential + jitter);
    }
  }
}
