import { runScenarios } from "../helpers/scenarios.js";
import { describe, expect, it } from "vitest";
import {
  BatchTransportError,
  buildBatchRequestBody,
  extractBoundary,
  messageGetPath,
  parseBatchResponseBody,
  sendGmailMessagesBatch
} from "../../src/gmail/batch.js";
import type { OAuth2Client } from "google-auth-library";

function fakeOAuthClient(handler: (opts: unknown) => Promise<{ data: unknown; headers: Record<string, unknown> }>) {
  return { request: handler } as unknown as OAuth2Client;
}

function responsePart(contentId: string, status: number, body?: unknown): string {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  return (
    `Content-Type: application/http\r\n` +
    `Content-ID: <response-${contentId}>\r\n\r\n` +
    `HTTP/1.1 ${status} X\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${bodyText}\r\n`
  );
}

function wrapParts(boundary: string, parts: string[]): string {
  return parts.map((p) => `--${boundary}\r\n${p}`).join("") + `--${boundary}--`;
}

describe("messageGetPath", () => {
  it("builds a relative path with format and fields, URL-encoded", () => {
    expect(messageGetPath("m 1", "full", "id,threadId")).toBe(
      "/gmail/v1/users/me/messages/m%201?format=full&fields=id%2CthreadId"
    );
  });
});

describe("extractBoundary", () => {
  it("preserves all 3 scenarios", async () => {
    await runScenarios([
      { name: "extracts a bare boundary value", run: () => {
    expect(extractBoundary("multipart/mixed; boundary=batch_abc123")).toBe("batch_abc123");
  } },
      { name: "extracts a quoted boundary value", run: () => {
    expect(extractBoundary('multipart/mixed; boundary="batch_abc123"')).toBe("batch_abc123");
  } },
      { name: "returns null for a missing or non-multipart content-type", run: () => {
    expect(extractBoundary("application/json")).toBeNull();
    expect(extractBoundary(undefined)).toBeNull();
    expect(extractBoundary(null)).toBeNull();
  } }
    ]);
  });
});

describe("buildBatchRequestBody", () => {
  it("emits one multipart part per id, addressed by Content-ID, terminated by the closing boundary", () => {
    const body = buildBatchRequestBody(["a", "b"], (id) => `/gmail/v1/users/me/messages/${id}`, "B1");
    expect(body).toContain("--B1\r\nContent-Type: application/http\r\nContent-ID: <a>");
    expect(body).toContain("GET /gmail/v1/users/me/messages/a HTTP/1.1");
    expect(body).toContain("Content-ID: <b>");
    expect(body.trim().endsWith("--B1--")).toBe(true);
    expect(body).toContain("HTTP/1.1\r\n\r\n\r\n--B1");
  });
});

describe("parseBatchResponseBody", () => {
  it("preserves all 5 scenarios", async () => {
    await runScenarios([
      { name: "maps parts by Content-ID regardless of response order", run: () => {
    const boundary = "B1";
    const body = wrapParts(boundary, [responsePart("b", 200, { id: "b" }), responsePart("a", 200, { id: "a" })]);
    const parts = parseBatchResponseBody(body, boundary);
    expect(parts).toHaveLength(2);
    expect(parts.find((p) => p.contentId === "a")?.body).toEqual({ id: "a" });
    expect(parts.find((p) => p.contentId === "b")?.body).toEqual({ id: "b" });
  } },
      { name: "preserves mixed status codes (2xx, 404, 429, 5xx)", run: () => {
    const boundary = "B1";
    const body = wrapParts(boundary, [
      responsePart("ok", 200, { id: "ok" }),
      responsePart("missing", 404, { error: "not found" }),
      responsePart("throttled", 429, { error: "quota" }),
      responsePart("outage", 503, { error: "unavailable" })
    ]);
    const parts = parseBatchResponseBody(body, boundary);
    const byId = new Map(parts.map((p) => [p.contentId, p.status]));
    expect(byId.get("ok")).toBe(200);
    expect(byId.get("missing")).toBe(404);
    expect(byId.get("throttled")).toBe(429);
    expect(byId.get("outage")).toBe(503);
  } },
      { name: "flags a part with no Content-ID rather than silently dropping it", run: () => {
    const boundary = "B1";
    const malformedPart =
      `Content-Type: application/http\r\n\r\n` + `HTTP/1.1 200 OK\r\n\r\n` + `{"id":"x"}\r\n`;
    const body = `--${boundary}\r\n${malformedPart}--${boundary}--`;
    const parts = parseBatchResponseBody(body, boundary);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.contentId).toBeNull();
    expect(parts[0]!.parseError).not.toBeNull();
  } },
      { name: "flags a part with a non-JSON body instead of throwing", run: () => {
    const boundary = "B1";
    const malformedPart =
      `Content-Type: application/http\r\n` +
      `Content-ID: <response-a>\r\n\r\n` +
      `HTTP/1.1 200 OK\r\n\r\n` +
      `not json`;
    const body = `--${boundary}\r\n${malformedPart}\r\n--${boundary}--`;
    const parts = parseBatchResponseBody(body, boundary);
    expect(parts[0]!.contentId).toBe("a");
    expect(parts[0]!.parseError).not.toBeNull();
  } },
      { name: "ignores the preamble and closing marker, never treating them as parts", run: () => {
    const boundary = "B1";
    const body = `preamble text\r\n--${boundary}\r\n${responsePart("a", 200, {})}--${boundary}--\r\n`;
    const parts = parseBatchResponseBody(body, boundary);
    expect(parts).toHaveLength(1);
  } }
    ]);
  });
});

describe("sendGmailMessagesBatch", () => {
  it("preserves all 10 scenarios", async () => {
    await runScenarios([
      { name: "rejects duplicate, unexpected, mismatched and empty success parts", run: async () => {
    const client = fakeOAuthClient(async () => ({
      data: wrapParts("B1", [
        responsePart("a", 200, { id: "a" }), responsePart("a", 200, { id: "a" }),
        responsePart("extra", 200, { id: "extra" }), responsePart("b", 200, { id: "different" }),
        responsePart("c", 200)
      ]), headers: { "content-type": "multipart/mixed; boundary=B1" }
    }));
    const result = await sendGmailMessagesBatch(client, ["a", "b", "c"], { fields: "id" });
    expect(result.succeeded.size).toBe(0);
    expect([...result.failed.keys()].sort()).toEqual(["a", "b", "c"]);
    expect([...result.failed.values()].every((failure) => failure.retryable)).toBe(true);
  } },
      { name: "recognizes quota 403 reasons and Retry-After while leaving permission errors terminal", run: async () => {
    const quotaPart = responsePart("quota", 403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } })
      .replace("HTTP/1.1 403 X\r\n", "HTTP/1.1 403 X\r\nRetry-After: 7\r\n");
    const client = fakeOAuthClient(async () => ({
      data: wrapParts("B1", [quotaPart, responsePart("denied", 403, { error: { errors: [{ reason: "forbidden" }] } })]),
      headers: { "content-type": "multipart/mixed; boundary=B1" }
    }));
    const result = await sendGmailMessagesBatch(client, ["quota", "denied"], { fields: "id" });
    expect(result.failed.get("quota")).toMatchObject({ retryable: true, quotaPressure: true, retryAfterMs: 7000 });
    expect(result.failed.get("denied")).toMatchObject({ retryable: false });
  } },
      { name: "preserves boundary-looking content inside JSON and accepts spaced boundary parameters", run: async () => {
    const client = fakeOAuthClient(async () => ({
      data: wrapParts("B1", [responsePart("a", 200, { id: "a", snippet: "keep --B1 here" })]),
      headers: { "content-type": "multipart/mixed; boundary = B1 ; charset=UTF-8" }
    }));
    const result = await sendGmailMessagesBatch(client, ["a"], { fields: "id,snippet" });
    expect(result.succeeded.get("a")).toEqual({ id: "a", snippet: "keep --B1 here" });
    expect(result.decodedResponseBytes).toBeGreaterThan(0);
  } },
      { name: "returns an empty result without making a network call for zero ids", run: async () => {
    let called = false;
    const client = fakeOAuthClient(async () => {
      called = true;
      return { data: "", headers: {} };
    });
    const result = await sendGmailMessagesBatch(client, [], { fields: "id" });
    expect(result.succeeded.size).toBe(0);
    expect(result.failed.size).toBe(0);
    expect(called).toBe(false);
  } },
      { name: "sends Accept-Encoding: gzip and a gzip-tagged User-Agent, and posts multipart/mixed", run: async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const boundary = "resp1";
    const client = fakeOAuthClient(async (opts) => {
      capturedOpts = opts as Record<string, unknown>;
      return {
        data: wrapParts(boundary, [responsePart("m1", 200, { id: "m1" })]),
        headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
      };
    });
    await sendGmailMessagesBatch(client, ["m1"], { fields: "id,threadId" });
    const headers = capturedOpts?.["headers"] as Record<string, string>;
    expect(headers["Accept-Encoding"]).toBe("gzip");
    expect(headers["User-Agent"]).toContain("(gzip)");
    expect(String(headers["Content-Type"])).toContain("multipart/mixed");
    expect(capturedOpts?.["method"]).toBe("POST");
    expect(String(capturedOpts?.["data"])).toContain("GET /gmail/v1/users/me/messages/m1");
  } },
      { name: "sorts 2xx into succeeded and 404/429/5xx into failed with the right retryable flag", run: async () => {
    const boundary = "resp1";
    const client = fakeOAuthClient(async () => ({
      data: wrapParts(boundary, [
        responsePart("ok", 200, { id: "ok" }),
        responsePart("gone", 404, {}),
        responsePart("throttled", 429, {}),
        responsePart("outage", 503, {})
      ]),
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
    }));
    const result = await sendGmailMessagesBatch(client, ["ok", "gone", "throttled", "outage"], { fields: "id" });
    expect(result.succeeded.get("ok")).toEqual({ id: "ok" });
    expect(result.failed.get("gone")).toMatchObject({ status: 404, retryable: false });
    expect(result.failed.get("throttled")).toMatchObject({ status: 429, retryable: true });
    expect(result.failed.get("outage")).toMatchObject({ status: 503, retryable: true });
  } },
      { name: "accounts for a requested id whose part never came back at all, as retryable", run: async () => {
    const boundary = "resp1";
    const client = fakeOAuthClient(async () => ({
      data: wrapParts(boundary, [responsePart("a", 200, { id: "a" })]),
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
    }));
    const result = await sendGmailMessagesBatch(client, ["a", "b"], { fields: "id" });
    expect(result.succeeded.has("a")).toBe(true);
    expect(result.failed.get("b")).toMatchObject({ retryable: true });
  } },
      { name: "throws BatchTransportError when the outer request itself fails", run: async () => {
    const client = fakeOAuthClient(async () => {
      throw Object.assign(new Error("network down"), { status: 503 });
    });
    await expect(sendGmailMessagesBatch(client, ["a"], { fields: "id" })).rejects.toBeInstanceOf(BatchTransportError);
  } },
      { name: "throws BatchTransportError when the response content-type has no parseable boundary", run: async () => {
    const client = fakeOAuthClient(async () => ({ data: "garbage", headers: { "content-type": "text/plain" } }));
    await expect(sendGmailMessagesBatch(client, ["a"], { fields: "id" })).rejects.toBeInstanceOf(BatchTransportError);
  } },
      { name: "throws BatchTransportError when the multipart body has zero parseable parts (malformed boundary content)", run: async () => {
    const client = fakeOAuthClient(async () => ({
      data: "not actually multipart content",
      headers: { "content-type": "multipart/mixed; boundary=B1" }
    }));
    await expect(sendGmailMessagesBatch(client, ["a"], { fields: "id" })).rejects.toBeInstanceOf(BatchTransportError);
  } }
    ]);
  });
});
