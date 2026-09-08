import { describe, expect, it, vi } from "vitest";
import { hydrateMessagesBatched } from "../../src/gmail/batch-hydrate.js";
import { GoogleApiRateLimiter } from "../../src/core/api-retry.js";
import type { GmailClient } from "../../src/gmail/client.js";
import type { OAuth2Client } from "google-auth-library";

function responsePart(contentId: string, status: number, body: unknown = {}): string {
  return (
    `Content-Type: application/http\r\n` +
    `Content-ID: <response-${contentId}>\r\n\r\n` +
    `HTTP/1.1 ${status} X\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(body)}\r\n`
  );
}

function wrapParts(boundary: string, parts: string[]): string {
  return parts.map((p) => `--${boundary}\r\n${p}`).join("") + `--${boundary}--`;
}

function fakeOAuthClient(handler: (opts: unknown) => Promise<{ data: unknown; headers: Record<string, unknown> }>) {
  return { request: handler } as unknown as OAuth2Client;
}

/** No individual-fallback call in these tests should ever succeed by accident — assert loudly if one fires unexpectedly. */
function explodingGmailClient(): GmailClient {
  return {
    users: {
      messages: {
        get: async () => {
          throw new Error("fetchMessageFull should not have been called in this test");
        }
      }
    }
  } as unknown as GmailClient;
}

function individualFallbackGmailClient(behavior: (id: string) => { id: string } | null): GmailClient {
  return {
    users: {
      messages: {
        get: async (params: { id: string }) => {
          const result = behavior(params.id);
          if (result === null) throw new Error("simulated individual-read failure");
          return { data: result };
        }
      }
    }
  } as unknown as GmailClient;
}

function newTestLimiter(): GoogleApiRateLimiter {
  // Effectively unlimited pacing (like VITEST's real singleton override) so
  // these tests run instantly; still a real instance so acquire/report* can
  // be spied on.
  return new GoogleApiRateLimiter(1_000_000, 4_000, 1_000_000);
}

describe("hydrateMessagesBatched", () => {
  it("gives later messages their own retry budget and deduplicates IDs across chunks", async () => {
    const attempts = new Map<string, number>();
    const oauthClient = fakeOAuthClient(async (opts) => {
      const requested = [...String((opts as { data: string }).data).matchAll(/Content-ID: <([^>]+)>/g)].map((match) => match[1]!);
      return {
        data: wrapParts("B1", requested.map((id) => {
          const count = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, count);
          return responsePart(id, count === 1 ? 503 : 200, { id });
        })), headers: { "content-type": "multipart/mixed; boundary=B1" }
      };
    });
    const results = vi.fn();
    const diagnostics = await hydrateMessagesBatched(explodingGmailClient(), oauthClient, ["a", "a", "b", "c"], results,
      { rateLimiter: newTestLimiter(), initialBatchSize: 1, maxBatchRetryRounds: 1, maxRetryDelayMs: 0 });
    expect([...attempts.values()]).toEqual([2, 2, 2]);
    expect(results).toHaveBeenCalledTimes(3);
    expect(diagnostics).toMatchObject({ batchSucceeded: 3, individualFallback: 0, retriedMessages: 3 });
  });

  it("propagates callback errors without refetching or invoking the callback twice", async () => {
    const oauthClient = fakeOAuthClient(async () => ({
      data: wrapParts("B1", [responsePart("a", 200, { id: "a" })]),
      headers: { "content-type": "multipart/mixed; boundary=B1" }
    }));
    const callback = vi.fn(() => { throw new Error("database unavailable"); });
    await expect(hydrateMessagesBatched(explodingGmailClient(), oauthClient, ["a"], callback,
      { rateLimiter: newTestLimiter() })).rejects.toThrow("database unavailable");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("hydrates 525 messages exactly once with 11 quota-weighted batches", async () => {
    const oauthClient = fakeOAuthClient(async (opts) => {
      const ids = [...String((opts as { data: string }).data).matchAll(/Content-ID: <([^>]+)>/g)].map((match) => match[1]!);
      return { data: wrapParts("B1", ids.map((id) => responsePart(id, 200, { id }))),
        headers: { "content-type": "multipart/mixed; boundary=B1" } };
    });
    const results = vi.fn();
    const limiter = newTestLimiter();
    const acquire = vi.spyOn(limiter, "acquire");
    const diagnostics = await hydrateMessagesBatched(explodingGmailClient(), oauthClient,
      Array.from({ length: 525 }, (_, i) => String(i)), results, { rateLimiter: limiter });
    expect(results).toHaveBeenCalledTimes(525);
    expect(diagnostics).toMatchObject({ outerBatchRequests: 11, batchSucceeded: 525, individualFallback: 0 });
    expect(acquire.mock.calls.reduce((sum, [weight]) => sum + weight!, 0)).toBe(525);
  });

  it("uses bounded concurrent fallbacks and stops calling a broken batch endpoint", async () => {
    const oauthClient = fakeOAuthClient(vi.fn(async () => { throw new Error("batch unavailable"); }));
    let active = 0;
    let peak = 0;
    const gmailClient = { users: { messages: { get: async ({ id }: { id: string }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { data: { id } };
    } } } } as unknown as GmailClient;
    const results = vi.fn();
    const diagnostics = await hydrateMessagesBatched(gmailClient, oauthClient, ["a", "b", "c", "d", "e"], results,
      { rateLimiter: newTestLimiter(), initialBatchSize: 1, fallbackConcurrency: 3 });
    expect(peak).toBe(3);
    expect(results).toHaveBeenCalledTimes(5);
    expect(diagnostics).toMatchObject({ outerBatchRequests: 1, individualFallback: 5 });
  });

  it("hydrates every id via one batch call when everything succeeds, calling onResult once per id", async () => {
    const boundary = "B1";
    const oauthClient = fakeOAuthClient(async () => ({
      data: wrapParts(boundary, [
        responsePart("a", 200, { id: "a" }),
        responsePart("b", 200, { id: "b" })
      ]),
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
    }));
    const results = new Map<string, unknown>();
    const diagnostics = await hydrateMessagesBatched(
      explodingGmailClient(),
      oauthClient,
      ["a", "b"],
      (id, message) => {
        results.set(id, message);
      },
      { maxRetryDelayMs: 0, rateLimiter: newTestLimiter() }
    );
    expect(results.get("a")).toEqual({ id: "a" });
    expect(results.get("b")).toEqual({ id: "b" });
    expect(diagnostics.outerBatchRequests).toBe(1);
    expect(diagnostics.batchSucceeded).toBe(2);
    expect(diagnostics.individualFallback).toBe(0);
  });

  it("reserves quota weighted by the number of inner calls before sending, not a flat 1 per outer request", async () => {
    const boundary = "B1";
    const oauthClient = fakeOAuthClient(async () => ({
      data: wrapParts(boundary, [responsePart("a", 200, { id: "a" }), responsePart("b", 200, { id: "b" }), responsePart("c", 200, { id: "c" })]),
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
    }));
    const limiter = newTestLimiter();
    const acquireSpy = vi.spyOn(limiter, "acquire");
    await hydrateMessagesBatched(explodingGmailClient(), oauthClient, ["a", "b", "c"], () => {}, { maxRetryDelayMs: 0, rateLimiter: limiter });
    expect(acquireSpy).toHaveBeenCalledWith(3);
  });

  it("delivers a terminal failure (404) as null without retrying it", async () => {
    const boundary = "B1";
    let callCount = 0;
    const oauthClient = fakeOAuthClient(async () => {
      callCount += 1;
      return {
        data: wrapParts(boundary, [responsePart("gone", 404)]),
        headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
      };
    });
    const results = new Map<string, unknown>();
    const diagnostics = await hydrateMessagesBatched(
      explodingGmailClient(),
      oauthClient,
      ["gone"],
      (id, message) => { results.set(id, message); },
      { maxRetryDelayMs: 0, rateLimiter: newTestLimiter() }
    );
    expect(results.get("gone")).toBeNull();
    expect(diagnostics.batchFailedTerminal).toBe(1);
    expect(callCount).toBe(1); // never retried
  });

  it("retries only the retryable (429/5xx) part, never re-sending an already-succeeded id", async () => {
    const boundary = "B1";
    let attempt = 0;
    const oauthClient = fakeOAuthClient(async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          data: wrapParts(boundary, [responsePart("ok", 200, { id: "ok" }), responsePart("flaky", 429)]),
          headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
        };
      }
      // Retry round: only "flaky" should ever be requested again.
      return {
        data: wrapParts(boundary, [responsePart("flaky", 200, { id: "flaky", retried: true })]),
        headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
      };
    });
    // "ok" already succeeded in round 1 — it must never appear in any later
    // request body, only "flaky" (the retryable failure) should.
    let okRequestedAfterRoundOne = false;
    const underlyingRequest = oauthClient.request as (opts: unknown) => Promise<{ data: unknown; headers: Record<string, unknown> }>;
    const wrappedOauth = fakeOAuthClient(async (opts) => {
      if (attempt >= 1 && String((opts as { data: unknown }).data).includes("Content-ID: <ok>")) {
        okRequestedAfterRoundOne = true;
      }
      return underlyingRequest(opts);
    });
    const results = new Map<string, unknown>();
    const diagnostics = await hydrateMessagesBatched(
      explodingGmailClient(),
      wrappedOauth,
      ["ok", "flaky"],
      (id, message) => { results.set(id, message); },
      { maxRetryDelayMs: 0, rateLimiter: newTestLimiter() }
    );
    expect(results.get("ok")).toEqual({ id: "ok" });
    expect(results.get("flaky")).toEqual({ id: "flaky", retried: true });
    expect(diagnostics.outerBatchRequests).toBe(2);
    expect(okRequestedAfterRoundOne).toBe(false);
  });

  it("shrinks batch size and calls reportQuotaPressure on a 429-shaped inner failure", async () => {
    const boundary = "B1";
    const oauthClient = fakeOAuthClient(async () => ({
      data: wrapParts(boundary, [responsePart("a", 429)]),
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
    }));
    const limiter = newTestLimiter();
    const pressureSpy = vi.spyOn(limiter, "reportQuotaPressure");
    await hydrateMessagesBatched(
      individualFallbackGmailClient((id) => ({ id })),
      oauthClient,
      ["a"],
      () => {},
      { maxRetryDelayMs: 0, rateLimiter: limiter, maxBatchRetryRounds: 0 }
    );
    expect(pressureSpy).toHaveBeenCalled();
  });

  it("falls back to individual reads for the whole chunk when the outer batch request fails structurally", async () => {
    const oauthClient = fakeOAuthClient(async () => {
      throw Object.assign(new Error("boom"), { status: 503 });
    });
    const fetched = new Set<string>();
    const gmailClient = individualFallbackGmailClient((id) => {
      fetched.add(id);
      return { id };
    });
    const results = new Map<string, unknown>();
    const diagnostics = await hydrateMessagesBatched(
      gmailClient,
      oauthClient,
      ["a", "b"],
      (id, message) => { results.set(id, message); },
      { maxRetryDelayMs: 0, rateLimiter: newTestLimiter() }
    );
    expect([...fetched].sort()).toEqual(["a", "b"]);
    expect(results.get("a")).toEqual({ id: "a" });
    expect(results.get("b")).toEqual({ id: "b" });
    expect(diagnostics.individualFallback).toBe(2);
    expect(diagnostics.batchSucceeded).toBe(0);
  });

  it("never loses an already-successful id from an earlier chunk when a later chunk fails structurally", async () => {
    const boundary = "B1";
    let call = 0;
    const oauthClient = fakeOAuthClient(async () => {
      call += 1;
      if (call === 1) {
        return {
          data: wrapParts(boundary, [responsePart("a", 200, { id: "a" })]),
          headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
        };
      }
      throw Object.assign(new Error("boom"), { status: 503 });
    });
    const results = new Map<string, unknown>();
    await hydrateMessagesBatched(
      individualFallbackGmailClient((id) => ({ id })),
      oauthClient,
      ["a", "b"],
      (id, message) => { results.set(id, message); },
      { maxRetryDelayMs: 0, rateLimiter: newTestLimiter(), initialBatchSize: 1 }
    );
    expect(results.get("a")).toEqual({ id: "a" });
    expect(results.get("b")).toEqual({ id: "b" });
  });

  it("bounds total batch-retry rounds and eventually falls back to an individual read instead of looping forever", async () => {
    const boundary = "B1";
    const oauthClient = fakeOAuthClient(async () => ({
      data: wrapParts(boundary, [responsePart("always-flaky", 429)]),
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
    }));
    let individualFetchCount = 0;
    const gmailClient = individualFallbackGmailClient((id) => {
      individualFetchCount += 1;
      return { id };
    });
    const results = new Map<string, unknown>();
    const diagnostics = await hydrateMessagesBatched(
      gmailClient,
      oauthClient,
      ["always-flaky"],
      (id, message) => { results.set(id, message); },
      { maxRetryDelayMs: 0, rateLimiter: newTestLimiter(), maxBatchRetryRounds: 2 }
    );
    expect(individualFetchCount).toBe(1);
    expect(results.get("always-flaky")).toEqual({ id: "always-flaky" });
    expect(diagnostics.individualFallback).toBe(1);
  });

  it("calls onResult exactly once per id even when everything fails at every layer", async () => {
    const oauthClient = fakeOAuthClient(async () => {
      throw Object.assign(new Error("boom"), { status: 503 });
    });
    const gmailClient = individualFallbackGmailClient(() => null);
    const callCounts = new Map<string, number>();
    await hydrateMessagesBatched(
      gmailClient,
      oauthClient,
      ["a"],
      (id) => { callCounts.set(id, (callCounts.get(id) ?? 0) + 1); },
      { maxRetryDelayMs: 0, rateLimiter: newTestLimiter() }
    );
    expect(callCounts.get("a")).toBe(1);
  });
});

it("keeps full batches after quota/transient errors and sustains six 50-read batches per minute", async () => {
  // A quota failure must only alter admission timing, not transport capacity.
  const sizes: number[] = [];
  let outerAttempt = 0;
  const oauth = fakeOAuthClient(async (opts) => {
    const ids = [...String((opts as { data: string }).data).matchAll(/Content-ID: <([^>]+)>/g)].map((match) => match[1]!);
    sizes.push(ids.length);
    if (++outerAttempt === 1) throw Object.assign(new Error("temporary outage"), { status: 503 });
    return { data: wrapParts("B1", ids.map((id, index) =>
      responsePart(id, outerAttempt === 2 && index === 0 ? 429 : 200, { id }))),
      headers: { "content-type": "multipart/mixed; boundary=B1" } };
  });
  const results = vi.fn();
  await hydrateMessagesBatched(explodingGmailClient(), oauth, Array.from({ length: 150 }, (_, i) => String(i)), results,
    { rateLimiter: newTestLimiter(), maxRetryDelayMs: 0 });
  expect(sizes).toEqual([50, 50, 50, 50, 1]);
  expect(results).toHaveBeenCalledTimes(150);

  vi.useFakeTimers();
  try {
    const starts: number[] = [];
    const start = Date.now();
    const pacedOAuth = fakeOAuthClient(async (opts) => {
      const ids = [...String((opts as { data: string }).data).matchAll(/Content-ID: <([^>]+)>/g)].map((match) => match[1]!);
      expect(ids).toHaveLength(50);
      starts.push(Date.now() - start);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { data: wrapParts("B1", ids.map((id) => responsePart(id, 200, { id }))),
        headers: { "content-type": "multipart/mixed; boundary=B1" } };
    });
    const run = hydrateMessagesBatched(explodingGmailClient(), pacedOAuth,
      Array.from({ length: 600 }, (_, i) => String(i)), () => {},
      { rateLimiter: new GoogleApiRateLimiter(5, 4000, 5, 300) });
    await vi.advanceTimersByTimeAsync(120_000);
    const diagnostics = await run;
    expect(starts).toEqual(Array.from({ length: 12 }, (_, i) => i * 10_000));
    expect(diagnostics).toMatchObject({ batchReadAttempts: 600, fullBatchRequests: 12, smallestBatch: 50, largestBatch: 50 });
  } finally { vi.useRealTimers(); }
});
