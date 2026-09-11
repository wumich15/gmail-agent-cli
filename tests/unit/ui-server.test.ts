import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { startUiServer } from "../../src/ui/server.js";
import type { UiServerHandle } from "../../src/ui/server.js";
import type { UiSession, UiStatus } from "../../src/ui/operations.js";

/**
 * A session that never touches Gmail, SQLite, or the credential store, so
 * these tests exercise only the HTTP boundary: who is allowed to call it,
 * and what it refuses.
 */
function fakeSession(): UiSession {
  const status: UiStatus = {
    connection: {
      connected: false,
      emailDisplay: null,
      timezone: null,
      accountHash: null,
      automationEnabled: false,
      credentialStored: false,
      scopes: [],
      oauthClientSource: "none"
    },
    ai: { access: "off", ready: false, detail: "AI is off.", model: null, options: [] },
    run: { kind: "idle", startedAt: null, note: null, lastError: null, lastPreview: null, lastRun: null }
  };
  return {
    status: vi.fn().mockResolvedValue(status),
    startWork: vi.fn(),
    startConnect: vi.fn(),
    cancelCurrentConnect: vi.fn(),
    setAiAccess: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    runState: () => status.run,
    busy: () => false
  } as unknown as UiSession;
}

let handle: UiServerHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

function call(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers ?? {} },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("local UI server", () => {
  it("binds loopback only and hands back a one-time launch URL carrying the session key", async () => {
    handle = await startUiServer({ session: fakeSession() });
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?k=/);
    expect(handle.token.length).toBeGreaterThan(20);
  });

  it("serves the documentation without any session token, so docs work before signing in", async () => {
    handle = await startUiServer({ session: fakeSession() });
    const response = await call(handle.port, "/api/commands");
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as { commands: unknown[]; viewControls: unknown[] };
    expect(parsed.commands.length).toBeGreaterThan(0);
    expect(parsed.viewControls.length).toBeGreaterThan(0);
  });

  it("refuses account operations without the session token, and with a wrong one", async () => {
    handle = await startUiServer({ session: fakeSession() });
    expect((await call(handle.port, "/api/status")).status).toBe(401);
    expect((await call(handle.port, "/api/status", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call(handle.port, "/api/status", { headers: { authorization: `Bearer ${handle.token}` } })).status).toBe(200);
  });

  it("rejects a rebound Host header even when the token is correct", async () => {
    handle = await startUiServer({ session: fakeSession() });
    const response = await call(handle.port, "/api/status", {
      headers: { host: "attacker.example", authorization: `Bearer ${handle.token}` }
    });
    expect(response.status).toBe(421);
  });

  it("rejects a cross-origin request outright", async () => {
    handle = await startUiServer({ session: fakeSession() });
    const response = await call(handle.port, "/api/status", {
      headers: { origin: "https://evil.example", authorization: `Bearer ${handle.token}` }
    });
    expect(response.status).toBe(403);
  });

  it("never starts a real cleanup without an explicit confirmation in the request", async () => {
    const session = fakeSession();
    handle = await startUiServer({ session });
    const response = await call(handle.port, "/api/run", {
      method: "POST",
      headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
      body: JSON.stringify({ limit: 5 })
    });
    expect(response.status).toBe(400);
    expect(session.startWork).not.toHaveBeenCalled();
  });

  it("runs a preview as a dry run and a confirmed cleanup as a real one", async () => {
    const session = fakeSession();
    handle = await startUiServer({ session });
    const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };

    await call(handle.port, "/api/preview", { method: "POST", headers, body: JSON.stringify({ limit: 5 }) });
    expect(session.startWork).toHaveBeenCalledWith({ dryRun: true, limit: 5 });

    await call(handle.port, "/api/run", { method: "POST", headers, body: JSON.stringify({ confirm: true, limit: 5 }) });
    expect(session.startWork).toHaveBeenCalledWith({ dryRun: false, limit: 5 });
  });

  it("rejects the removed local option and unknown AI options instead of guessing", async () => {
    const session = fakeSession();
    handle = await startUiServer({ session });
    for (const choice of ["local", "something-else"]) {
      const response = await call(handle.port, "/api/ai", {
        method: "POST",
        headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
        body: JSON.stringify({ choice })
      });
      expect(response.status).toBe(400);
    }
    expect(session.setAiAccess).not.toHaveBeenCalled();
  });

  it("sends a content-security policy that forbids inline script and any external origin", async () => {
    handle = await startUiServer({ session: fakeSession() });
    const port = handle.port;
    const csp = await new Promise<string>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/", method: "GET" }, (res) => {
        res.resume();
        resolve(String(res.headers["content-security-policy"] ?? ""));
      });
      req.end();
    });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
  });
});
