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
      { rateLimiter: newTestLimiter() }
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
      data: wrapParts(boundary, [responsePart("a", 200), responsePart("b", 200), responsePart("c", 200)]),
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
    }));
    const limiter = newTestLimiter();
    const acquireSpy = vi.spyOn(limiter, "acquire");
    await hydrateMessagesBatched(explodingGmailClient(), oauthClient, ["a", "b", "c"], () => {}, { rateLimiter: limiter });
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
      { rateLimiter: newTestLimiter() }
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
      { rateLimiter: newTestLimiter() }
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
      { rateLimiter: limiter, maxBatchRetryRounds: 0 }
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
      { rateLimiter: newTestLimiter() }
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
      { rateLimiter: newTestLimiter(), initialBatchSize: 1 }
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
      { rateLimiter: newTestLimiter(), maxBatchRetryRounds: 2 }
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
      { rateLimiter: newTestLimiter() }
    );
    expect(callCounts.get("a")).toBe(1);
  });
});
