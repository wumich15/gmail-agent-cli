import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInvalidGrantError, resolveOAuthClientCredentials } from "../../src/auth/google-oauth.js";
import {
  oauthClientFilePath,
  readStoredOAuthClient,
  writeStoredOAuthClient
} from "../../src/auth/oauth-client-file.js";
import { InvalidConfigError } from "../../src/core/errors.js";

const created: string[] = [];

/** Points appDataDir() at a throwaway directory on every platform this runs on. */
function sandboxEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "gmail-agent-oauth-"));
  created.push(dir);
  return { GMAIL_AGENT_DATA_DIR: dir } as NodeJS.ProcessEnv;
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("resolveOAuthClientCredentials", () => {
  it("prefers an explicit environment client so a developer can use their own Cloud project", () => {
    const resolved = resolveOAuthClientCredentials({
      ...sandboxEnv(),
      GMAIL_AGENT_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com",
      GMAIL_AGENT_OAUTH_CLIENT_SECRET: "secret"
    } as NodeJS.ProcessEnv);
    expect(resolved.source).toBe("environment");
    expect(resolved.clientId).toBe("id.apps.googleusercontent.com");
  });

  it("falls back to the client this computer saved during setup", () => {
    const env = sandboxEnv();
    writeStoredOAuthClient({ clientId: "saved.apps.googleusercontent.com", clientSecret: "saved-secret" }, env);
    const resolved = resolveOAuthClientCredentials(env);
    expect(resolved).toMatchObject({
      source: "stored",
      clientId: "saved.apps.googleusercontent.com",
      clientSecret: "saved-secret"
    });
  });

  it("explains how to register a Google app rather than failing later inside OAuth", () => {
    const env = sandboxEnv();
    expect(() => resolveOAuthClientCredentials(env)).toThrow(InvalidConfigError);
    try {
      resolveOAuthClientCredentials(env);
    } catch (error) {
      // No shared client exists by design, so this message is the entire
      // onboarding path for a new user and must name the real steps.
      expect((error as Error).message).toContain("console.cloud.google.com");
      expect((error as Error).message).toContain("Desktop app");
      expect((error as Error).message).toContain("gmail setup");
    }
  });
});

describe("stored OAuth client file", () => {
  it("round-trips a saved client and rejects a value that is not a Google client ID", () => {
    const env = sandboxEnv();
    expect(readStoredOAuthClient(env)).toBeNull();
    writeStoredOAuthClient({ clientId: "x.apps.googleusercontent.com", clientSecret: "s" }, env);
    expect(readStoredOAuthClient(env)?.clientId).toBe("x.apps.googleusercontent.com");
    expect(() => writeStoredOAuthClient({ clientId: "not-a-client-id", clientSecret: "s" }, env)).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "refuses to read a client file other accounts on the computer can read",
    () => {
      const env = sandboxEnv();
      const path = writeStoredOAuthClient({ clientId: "x.apps.googleusercontent.com", clientSecret: "s" }, env);
      chmodSync(path, 0o644);
      expect(() => readStoredOAuthClient(env)).toThrow(/permissions/);
    }
  );

  it("reports a corrupted file as something to delete instead of crashing on parse", () => {
    const env = sandboxEnv();
    writeStoredOAuthClient({ clientId: "x.apps.googleusercontent.com", clientSecret: "s" }, env);
    writeFileSync(oauthClientFilePath(env), JSON.stringify({ clientId: "x.apps.googleusercontent.com" }), {
      mode: 0o600
    });
    expect(() => readStoredOAuthClient(env)).toThrow(/gmail setup/);
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
