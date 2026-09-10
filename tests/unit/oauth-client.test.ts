import { describe, expect, it } from "vitest";
import { isInvalidGrantError, resolveOAuthClientCredentials } from "../../src/auth/google-oauth.js";
import { publisherOAuthClientConfigured } from "../../src/auth/publisher-client.js";
import { InvalidConfigError } from "../../src/core/errors.js";

describe("resolveOAuthClientCredentials", () => {
  it("prefers an explicit environment client so a developer can use their own Cloud project", () => {
    const resolved = resolveOAuthClientCredentials({
      GMAIL_AGENT_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com",
      GMAIL_AGENT_OAUTH_CLIENT_SECRET: "secret"
    } as NodeJS.ProcessEnv);
    expect(resolved.source).toBe("environment");
    expect(resolved.clientId).toBe("id.apps.googleusercontent.com");
  });

  it("falls back to the publisher client, or explains what to do when this build has neither", () => {
    const attempt = () => resolveOAuthClientCredentials({} as NodeJS.ProcessEnv);
    if (publisherOAuthClientConfigured()) {
      expect(attempt().source).toBe("publisher");
      return;
    }
    // The source tree ships no publisher client yet, and must say so
    // plainly rather than failing with an opaque OAuth error later.
    expect(attempt).toThrow(InvalidConfigError);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).toContain("GMAIL_AGENT_OAUTH_CLIENT_ID");
    }
  });
});

describe("isInvalidGrantError", () => {
  it("recognizes a revoked or expired grant from either error shape Google uses", () => {
    expect(isInvalidGrantError(new Error("invalid_grant: Token has been expired or revoked."))).toBe(true);
    expect(isInvalidGrantError({ response: { data: { error: "invalid_grant" } } })).toBe(true);
  });

  it("does not mistake an ordinary failure for one, which would erase a working credential", () => {
    expect(isInvalidGrantError(new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com"))).toBe(false);
    expect(isInvalidGrantError({ response: { data: { error: "rateLimitExceeded" } } })).toBe(false);
    expect(isInvalidGrantError(null)).toBe(false);
  });
});
