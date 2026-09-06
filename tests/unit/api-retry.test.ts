import { describe, expect, it, vi } from "vitest";
import { apiErrorStatus, GoogleApiRateLimiter, withApiRetry, withGoogleApiRetry } from "../../src/core/api-retry.js";

function gaxiosLikeError(status: number, retryAfterSeconds?: number): unknown {
  return {
    message: `request failed with status ${status}`,
    status,
    response: retryAfterSeconds !== undefined ? { headers: { get: () => String(retryAfterSeconds) } } : undefined
  };
}

describe("apiErrorStatus", () => {
  it("reads the numeric HTTP status gaxios sets on .status, not .code", () => {
    // gaxios only sets .code for low-level network errors (e.g.
    // ECONNRESET); the real HTTP status of a response lives on .status.
    expect(apiErrorStatus(gaxiosLikeError(404))).toBe(404);
    expect(apiErrorStatus(gaxiosLikeError(429))).toBe(429);
  });

  it("is undefined for a plain Error with no status", () => {
    expect(apiErrorStatus(new Error("boom"))).toBeUndefined();
  });
});

describe("withApiRetry", () => {
  it("returns the result immediately on success, no retries", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withApiRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(gaxiosLikeError(429))
      .mockRejectedValueOnce(gaxiosLikeError(429))
      .mockResolvedValue("ok");
    const result = await withApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on 5xx", async () => {
    const fn = vi.fn().mockRejectedValueOnce(gaxiosLikeError(503)).mockResolvedValue("ok");
    const result = await withApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 });
    expect(result).toBe("ok");
  });

  it("never retries a 404 or other non-transient error", async () => {
    const fn = vi.fn().mockRejectedValue(gaxiosLikeError(404));
    await expect(withApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(gaxiosLikeError(429));
    await expect(
      withApiRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 })
    ).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("with no options override, retries 7 times and accumulates ~61s of backoff — enough to span a per-minute quota window", async () => {
    // Regression: the previous default (maxAttempts: 5) only ever
    // accumulated ~15s of total backoff, nowhere near long enough for a
    // Gmail "Units per minute per user" quota error (a real one observed
    // in production) to actually clear before the retry budget gave up.
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValue(gaxiosLikeError(429));
      const promise = withApiRetry(fn);
      const assertion = expect(promise).rejects.toBeDefined();
      // Drain every pending backoff sleep; jitter adds up to +25% on top
      // of the nominal 1+2+4+8+16+30 = 61s, so advance well past that.
      await vi.advanceTimersByTimeAsync(90_000);
      await assertion;
      expect(fn).toHaveBeenCalledTimes(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a Retry-After header instead of the computed backoff", async () => {
    const fn = vi.fn().mockRejectedValueOnce(gaxiosLikeError(429, 0)).mockResolvedValue("ok");
    const start = Date.now();
    const result = await withApiRetry(fn, { baseDelayMs: 10_000, maxDelayMs: 20_000 });
    // Retry-After: 0 should short-circuit the otherwise-huge backoff.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toBe("ok");
  });

  it("honors a Retry-After header in the HTTP-date form, not just delta-seconds", async () => {
    const soon = new Date(Date.now() + 1).toUTCString();
    const error = {
      status: 429,
      response: { headers: { get: () => soon } }
    };
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("ok");
    const start = Date.now();
    const result = await withApiRetry(fn, { baseDelayMs: 10_000, maxDelayMs: 20_000 });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toBe("ok");
  });

  it("retries a bare network error (no HTTP status) like ECONNRESET", async () => {
    const networkError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fn = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValue("ok");
    const result = await withApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries Google's Service Infrastructure quota error even with no numeric .status, for a per-minute limit", async () => {
    // Regression: this exact error shape (a bare Error with the quota
    // message but no usable .status) was observed reaching withApiRetry
    // and failing immediately with zero retries during a large `gmail
    // cache` run, even though a per-minute quota is exactly as transient
    // as a 429.
    const quotaError = new Error(
      "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service " +
        "'gmail.googleapis.com' for consumer 'project_number:944865497602'."
    );
    const fn = vi.fn().mockRejectedValueOnce(quotaError).mockResolvedValue("ok");
    const result = await withApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a daily/lifetime Google quota error — it won't clear within this process's retry budget", async () => {
    const dailyQuotaError = new Error(
      "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per day' of service 'gmail.googleapis.com'."
    );
    const fn = vi.fn().mockRejectedValue(dailyQuotaError);
    await expect(withApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 })).rejects.toBe(dailyQuotaError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unrelated .code (not a known network error code) as retryable", async () => {
    const error = Object.assign(new Error("boom"), { code: "SOME_OTHER_CODE" });
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("GoogleApiRateLimiter", () => {
  it("paces successive acquire() calls to no faster than the configured rate", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new GoogleApiRateLimiter(10); // 100ms between requests
      const first = limiter.acquire();
      await vi.advanceTimersByTimeAsync(0);
      await first;
      const start = Date.now();
      const second = limiter.acquire();
      await vi.advanceTimersByTimeAsync(100);
      await second;
      expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("halves its rate (doubles the interval) on reportQuotaPressure, up to the ceiling", () => {
    const limiter = new GoogleApiRateLimiter(10, 8_000); // starts at 100ms interval
    expect(limiter.currentRequestsPerSecond).toBeCloseTo(10);
    limiter.reportQuotaPressure();
    expect(limiter.currentRequestsPerSecond).toBeCloseTo(5);
    limiter.reportQuotaPressure();
    expect(limiter.currentRequestsPerSecond).toBeCloseTo(2.5);
  });

  it("never backs off past its configured ceiling interval", () => {
    const limiter = new GoogleApiRateLimiter(10, 500); // ceiling: 500ms interval = 2 req/s floor speed
    for (let i = 0; i < 10; i++) limiter.reportQuotaPressure();
    expect(limiter.currentRequestsPerSecond).toBeCloseTo(2);
  });

  it("creeps back toward the original rate after a sustained streak of successes", () => {
    const limiter = new GoogleApiRateLimiter(10, 8_000);
    limiter.reportQuotaPressure(); // now at 5 req/s
    for (let i = 0; i < 25; i++) limiter.reportSuccess();
    expect(limiter.currentRequestsPerSecond).toBeGreaterThan(5);
    expect(limiter.currentRequestsPerSecond).toBeLessThanOrEqual(10);
  });

  it("never recovers past its original (floor interval) rate", () => {
    const limiter = new GoogleApiRateLimiter(10, 8_000);
    for (let i = 0; i < 1000; i++) limiter.reportSuccess();
    expect(limiter.currentRequestsPerSecond).toBeCloseTo(10);
  });
});

describe("withGoogleApiRetry", () => {
  it("reports quota pressure to the shared limiter and still succeeds after retrying", async () => {
    const fn = vi.fn().mockRejectedValueOnce(gaxiosLikeError(429)).mockResolvedValue("ok");
    const result = await withGoogleApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-retryable error without swallowing it", async () => {
    const fn = vi.fn().mockRejectedValue(gaxiosLikeError(404));
    await expect(withGoogleApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
