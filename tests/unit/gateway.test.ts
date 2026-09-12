import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "../../gateway/src/app.js";
import { loadGatewayConfig, SERVED_CONTRACT_VERSION } from "../../gateway/src/config.js";
import { pseudonymousUserId } from "../../gateway/src/identity.js";
import { logRequest } from "../../gateway/src/logging.js";

/**
 * The gateway checks that must hold before anything touches Firebase, a
 * provider, or a user's mail: an unsupported method, an unknown route, the
 * incident kill switch, and a contract version this deployment does not serve.
 *
 * These run ahead of identity verification on purpose, so they are the part of
 * the service that can be proven without a Firebase project — and they are
 * also the part that must never accidentally start doing work first.
 */

const ENVIRONMENT = {
  GATEWAY_GOOGLE_OAUTH_CLIENT_ID: "publisher-123.apps.googleusercontent.com",
  USER_ID_HMAC_KEY: "test-hmac-key",
  GATEWAY_POLICY_VERSION: "hosted-ai-2026-09-12",
  GATEWAY_PROVIDER_BASE_URL: "https://models.example.test/v1",
  GATEWAY_PROVIDER_API_KEY: "provider-key",
  GATEWAY_CLASSIFY_MODEL: "pinned-model-snapshot"
} satisfies NodeJS.ProcessEnv;

const deps = (overrides: Partial<NodeJS.ProcessEnv> = {}) => ({
  config: loadGatewayConfig({ ...ENVIRONMENT, ...overrides }),
  now: () => new Date("2026-09-12T12:00:00.000Z")
});

function request(path: string, body: unknown, method = "POST") {
  return { method, path, headers: { authorization: "Bearer whatever" }, body };
}

describe("gateway configuration", () => {
  it("refuses to start without the settings it cannot invent", () => {
    // A gateway that came up with no pinned model, no HMAC key, or no audience
    // would be a service that either fails every request or authenticates
    // nobody correctly. Failing at startup is the honest outcome.
    for (const missing of Object.keys(ENVIRONMENT)) {
      const partial = { ...ENVIRONMENT } as Record<string, string>;
      delete partial[missing];
      expect(() => loadGatewayConfig(partial)).toThrow(new RegExp(missing));
    }
  });

  it("defaults the privacy routing on, so forgetting to set it cannot weaken it", () => {
    const config = loadGatewayConfig(ENVIRONMENT);
    expect(config.provider.requireZeroDataRetention).toBe(true);
    expect(config.provider.denyUpstreamDataCollection).toBe(true);
    expect(config.killSwitch).toBe(false);
    // Drafting falls back to the classification model rather than to nothing.
    expect(config.provider.draftModel).toBe("pinned-model-snapshot");
  });
});

describe("gateway request gating", () => {
  it("serves only POST, and only the four documented paths", async () => {
    expect(await handleGatewayRequest(request("/v1/ai/classify", {}, "GET"), deps())).toMatchObject({ status: 405 });
    expect(await handleGatewayRequest(request("/v1/models", {}), deps())).toMatchObject({ status: 404 });
    // Explicitly: there is no proxy route. A caller cannot reach a provider
    // API shape through this service.
    expect(await handleGatewayRequest(request("/v1/chat/completions", {}), deps())).toMatchObject({ status: 404 });
    expect(await handleGatewayRequest(request("/v1/responses", {}), deps())).toMatchObject({ status: 404 });
  });

  it("honours the kill switch before doing any work at all", async () => {
    const response = await handleGatewayRequest(
      request("/v1/ai/classify", { contractVersion: SERVED_CONTRACT_VERSION }),
      deps({ GATEWAY_DISABLED: "true" })
    );
    expect(response.status).toBe(503);
  });

  it("tells a client speaking an unserved contract version to upgrade", async () => {
    const response = await handleGatewayRequest(request("/v1/ai/classify", { contractVersion: 99 }), deps());
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toMatch(/Upgrade the CLI/);
  });
});

describe("pseudonymous identity", () => {
  it("is stable for one account and unrecoverable without the key", () => {
    const key = "secret-key";
    const id = pseudonymousUserId("1234567890", key);
    expect(pseudonymousUserId("1234567890", key)).toBe(id);
    expect(id).not.toContain("1234567890");
    // A different deployment key yields a different pseudonym, so records
    // cannot be correlated across environments.
    expect(pseudonymousUserId("1234567890", "other-key")).not.toBe(id);
  });
});

describe("request logging", () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records only counters and classifications, never anything derived from mail", () => {
    logRequest({
      operation: "ai.classify",
      userId: "pseudonym",
      status: 200,
      durationMs: 12,
      outcome: "ok",
      totalTokens: 500,
      contractVersion: SERVED_CONTRACT_VERSION
    });
    const entry = JSON.parse(written[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual([
      "contractVersion",
      "durationMs",
      "operation",
      "outcome",
      "service",
      "severity",
      "status",
      "totalTokens",
      "userId"
    ]);
  });

  it("separates real failures from ordinary rejections so an alert can fire on one", () => {
    logRequest({ operation: "ai.draft", userId: null, status: 429, durationMs: 1, outcome: "quota_exceeded" });
    logRequest({ operation: "ai.draft", userId: null, status: 500, durationMs: 1, outcome: "error" });
    expect(JSON.parse(written[0] ?? "{}")).toMatchObject({ severity: "WARNING" });
    expect(JSON.parse(written[1] ?? "{}")).toMatchObject({ severity: "ERROR" });
  });
});
