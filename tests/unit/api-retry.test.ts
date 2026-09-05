import { describe, expect, it, vi } from "vitest";
import { apiErrorStatus, withApiRetry } from "../../src/core/api-retry.js";

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

  it("honors a Retry-After header instead of the computed backoff", async () => {
    const fn = vi.fn().mockRejectedValueOnce(gaxiosLikeError(429, 0)).mockResolvedValue("ok");
    const start = Date.now();
    const result = await withApiRetry(fn, { baseDelayMs: 10_000, maxDelayMs: 20_000 });
    // Retry-After: 0 should short-circuit the otherwise-huge backoff.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toBe("ok");
  });
});
