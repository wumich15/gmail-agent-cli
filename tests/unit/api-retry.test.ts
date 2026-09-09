import { describe, expect, it, vi } from "vitest";
import {
  apiErrorStatus,
  isGoogleQuotaError,
  googleApiRateLimiter,
  GoogleApiRateLimiter,
  withApiRetry,
  withGoogleApiRetry
} from "../../src/core/api-retry.js";

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

  it("caps Retry-After at maxDelayMs so a provider cannot create an unbounded wait", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValueOnce(gaxiosLikeError(429, 60)).mockResolvedValue("ok");
      const promise = withApiRetry(fn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1_000 });

      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(promise).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("reserves distinct globally-spaced slots for concurrent acquire() calls", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new GoogleApiRateLimiter(10); // 100ms between requests
      const startedAt = Date.now();
      const requests = Array.from({ length: 3 }, async () => {
        await limiter.acquire();
        return Date.now() - startedAt;
      });

      await vi.advanceTimersByTimeAsync(200);
      await expect(Promise.all(requests)).resolves.toEqual([0, 100, 200]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits a whole burst at once before the pace applies", async () => {
    // Gmail's quota is a per-minute bucket, so a run must be able to spend
    // its allowance immediately rather than one request per interval. This
    // is what makes `gmail --limit 100` finish in seconds instead of ~22s.
    vi.useFakeTimers();
    try {
      const limiter = new GoogleApiRateLimiter(10, 4000, 10, Infinity, 5); // 100ms pace, 5 deep
      const startedAt = Date.now();
      const requests = Array.from({ length: 6 }, async () => {
        await limiter.acquire();
        return Date.now() - startedAt;
      });

      await vi.advanceTimersByTimeAsync(200);
      await expect(Promise.all(requests)).resolves.toEqual([0, 0, 0, 0, 0, 100]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still caps a burst at the rolling minute budget", async () => {
    vi.useFakeTimers();
    try {
      // Bucket deep enough for 100, but only 3 units of quota per minute.
      const limiter = new GoogleApiRateLimiter(1000, 4000, 1000, 3, 100);
      const startedAt = Date.now();
      const requests = Array.from({ length: 4 }, async () => {
        await limiter.acquire();
        return Date.now() - startedAt;
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await expect(Promise.all(requests)).resolves.toEqual([0, 0, 0, 60_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spends the accumulated burst when quota pressure slows the pace", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new GoogleApiRateLimiter(10, 8_000, 10, Infinity, 5);
      limiter.reportQuotaPressure();
      const startedAt = Date.now();
      const requests = Array.from({ length: 2 }, async () => {
        await limiter.acquire();
        return Date.now() - startedAt;
      });

      // The burst is gone, so the second request waits a full (now halved)
      // 200ms interval instead of riding the bucket the pressure built up.
      await vi.advanceTimersByTimeAsync(200);
      await expect(Promise.all(requests)).resolves.toEqual([0, 200]);
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

  it("acquire(weight) reserves that many pacing intervals, not just one", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new GoogleApiRateLimiter(10); // 100ms between baseline (weight-1) requests
      const startedAt = Date.now();
      const first = limiter.acquire(2); // costs 2 baseline slots = 200ms
      await vi.advanceTimersByTimeAsync(0);
      await first;
      const secondTimestamp = (async () => {
        await limiter.acquire();
        return Date.now() - startedAt;
      })();
      await vi.advanceTimersByTimeAsync(200);
      // The weight-2 first call reserved through t=200ms, so the very next
      // (weight-1) call must wait until then, not just 100ms after the first.
      await expect(secondTimestamp).resolves.toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with an explicit fastest rate, recovers above its cautious start rate after sustained success", () => {
    const limiter = new GoogleApiRateLimiter(4, 8_000, 12);
    expect(limiter.currentRequestsPerSecond).toBeCloseTo(4);
    for (let i = 0; i < 1000; i++) limiter.reportSuccess();
    expect(limiter.currentRequestsPerSecond).toBeCloseTo(12);
  });

  it("a quota-pressure backoff still recovers only up to the fastest rate, never beyond it", () => {
    const limiter = new GoogleApiRateLimiter(4, 8_000, 12);
    limiter.reportQuotaPressure();
    for (let i = 0; i < 1000; i++) limiter.reportSuccess();
    expect(limiter.currentRequestsPerSecond).toBeCloseTo(12);
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

  it("retries a 5xx without treating the provider outage as quota pressure", async () => {
    const quotaPressure = vi.spyOn(googleApiRateLimiter, "reportQuotaPressure");
    try {
      const fn = vi.fn().mockRejectedValueOnce(gaxiosLikeError(503)).mockResolvedValue("ok");
      await expect(withGoogleApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 })).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
      expect(quotaPressure).not.toHaveBeenCalled();
    } finally {
      quotaPressure.mockRestore();
    }
  });

  it("does not impose an artificial cooldown on a quota error with no server Retry-After — only halves the pace", async () => {
    // Regression: this used to fall back to a flat 10-second hard cooldown
    // (blocking every in-flight/queued Gmail worker, not just the failed
    // call) whenever Google's quota error carried no parseable Retry-After
    // — which is the common case — making a single quota-shaped failure
    // stall the whole run for 10s on top of the already-halved pace.
    const quotaPressure = vi.spyOn(googleApiRateLimiter, "reportQuotaPressure");
    try {
      const fn = vi.fn().mockRejectedValueOnce(gaxiosLikeError(429)).mockResolvedValue("ok");
      await withGoogleApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 });
      expect(quotaPressure).toHaveBeenCalledWith(0);
    } finally {
      quotaPressure.mockRestore();
    }
  });

  it("still honors a real, server-provided Retry-After on a quota error", async () => {
    const quotaPressure = vi.spyOn(googleApiRateLimiter, "reportQuotaPressure");
    try {
      const fn = vi.fn().mockRejectedValueOnce(gaxiosLikeError(429, 3)).mockResolvedValue("ok");
      await withGoogleApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 5_000 });
      expect(quotaPressure).toHaveBeenCalledWith(3000);
    } finally {
      quotaPressure.mockRestore();
    }
  });

  it("pauses for the full rolling window on an explicit per-minute quota error without reducing the sustainable pace", async () => {
    const pause = vi.spyOn(googleApiRateLimiter, "pauseForQuotaWindow").mockImplementation(() => {});
    const slowDown = vi.spyOn(googleApiRateLimiter, "reportQuotaPressureForAttempt");
    try {
      const quotaError = Object.assign(new Error(
        "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'."
      ), { status: 403 });
      const fn = vi.fn().mockRejectedValueOnce(quotaError).mockResolvedValue("ok");
      await expect(withGoogleApiRetry(fn, { baseDelayMs: 1, maxDelayMs: 2 })).resolves.toBe("ok");
      expect(pause).toHaveBeenCalledWith(60_000);
      expect(slowDown).not.toHaveBeenCalled();
    } finally {
      pause.mockRestore();
      slowDown.mockRestore();
    }
  });
});


describe("shared quota recovery", () => {
  it("recognizes 403 rate-limit reasons without retrying permission failures", () => {
    expect(isGoogleQuotaError({ status: 403, response: { data: { error: { errors: [{ reason: "userRateLimitExceeded" }] } } } })).toBe(true);
    expect(isGoogleQuotaError({ status: 403, response: { data: { error: { errors: [{ reason: "forbidden" }] } } } })).toBe(false);
  });

  it("slows once for concurrent failures and holds already queued requests for the shared cooldown", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new GoogleApiRateLimiter(10);
      await limiter.acquire();
      const admitted = vi.fn();
      const queued = limiter.acquire().then(admitted);
      limiter.reportQuotaPressure(1000);
      limiter.reportQuotaPressure(1000);
      expect(limiter.currentRequestsPerSecond).toBe(5);
      await vi.advanceTimersByTimeAsync(999);
      expect(admitted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await queued;
      expect(admitted).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("counts every inner read against the rolling minute budget", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new GoogleApiRateLimiter(1000, 4000, 1000, 100);
      await limiter.acquire(50);
      const second = limiter.acquire(50);
      await vi.advanceTimersByTimeAsync(50);
      await second;
      const admitted = vi.fn();
      const third = limiter.acquire(50).then(admitted);
      await vi.advanceTimersByTimeAsync(59_949);
      expect(admitted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await third;
      expect(admitted).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("holds a per-minute quota wave without ratcheting the configured request rate down", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new GoogleApiRateLimiter(10);
      await limiter.acquire();
      const before = limiter.currentRequestsPerSecond;
      const admitted = vi.fn();
      const queued = limiter.acquire().then(admitted);
      limiter.pauseForQuotaWindow(60_000);
      limiter.pauseForQuotaWindow(60_000);
      expect(limiter.currentRequestsPerSecond).toBe(before);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(admitted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await queued;
      expect(admitted).toHaveBeenCalledTimes(1);
      expect(limiter.currentRequestsPerSecond).toBe(before);
    } finally { vi.useRealTimers(); }
  });
});


it("halves once for a wave of failed individual reads without adding an artificial cooldown", () => {
  const limiter = new GoogleApiRateLimiter(5);
  for (let i = 0; i < 8; i++) limiter.reportQuotaPressureForAttempt(5, 0);
  expect(limiter.currentRequestsPerSecond).toBe(2.5);
  expect(limiter.quotaCooldownRemainingMs).toBe(0);
  limiter.reportQuotaPressureForAttempt(2.5, 0);
  expect(limiter.currentRequestsPerSecond).toBe(1.25);
});
