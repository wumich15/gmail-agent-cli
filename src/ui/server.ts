import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { APP_CSS, APP_HTML, APP_JS } from "./assets.js";
import { commandReference, UiError, UiSession } from "./operations.js";
import type { AiAccessId } from "../core/ai-access.js";

/**
 * The local front-end's HTTP surface.
 *
 * Security model, all of it deliberate:
 *
 * - **Loopback only.** The listener binds `127.0.0.1`, so nothing on the
 *   network can reach it even on a shared or hostile Wi-Fi.
 * - **A per-launch session token.** Generated fresh for each `gmail ui`
 *   and never persisted, so it dies with the process. It reaches the page
 *   once through the launch URL and then lives only in page memory; the
 *   page strips it from the address bar so a bookmark cannot capture it.
 * - **No ambient credential, therefore no classic CSRF.** Authentication
 *   is an `Authorization: Bearer` header, never a cookie. Another site in
 *   the same browser cannot attach it, and cannot even send that header
 *   cross-origin without a preflight this server refuses.
 * - **Host and Origin are validated anyway**, which is what stops DNS
 *   rebinding: a rebound name resolving to 127.0.0.1 still carries a Host
 *   header that is not one of ours.
 * - **No secret ever crosses this boundary.** The operations layer returns
 *   status and typed summaries; Google tokens and any AI key stay in this
 *   process and the OS credential store.
 */

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface UiServerHandle {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
  server: Server;
}

export interface StartUiServerOptions {
  port?: number;
  session?: UiSession;
}

export function startUiServer(options: StartUiServerOptions = {}): Promise<UiServerHandle> {
  const token = randomBytes(32).toString("base64url");
  const session = options.session ?? new UiSession();
  const server = createServer((req, res) => {
    handle(req, res, token, session).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/?k=${token}`,
        port: address.port,
        token,
        server,
        close: () =>
          new Promise<void>((done) => {
            // A browser holds its connection open between polls, so
            // `close()` alone would wait for a keep-alive socket that is
            // never going to send anything — Ctrl-C would appear to hang.
            server.closeAllConnections();
            server.close(() => done());
          })
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, token: string, session: UiSession): Promise<void> {
  if (!hostAllowed(req)) {
    sendJson(res, 421, { error: "This page is only served to this computer." });
    return;
  }
  if (!originAllowed(req)) {
    sendJson(res, 403, { error: "Cross-origin requests are not accepted." });
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    send(res, 200, "text/html; charset=utf-8", APP_HTML);
    return;
  }
  if (req.method === "GET" && path === "/app.css") {
    send(res, 200, "text/css; charset=utf-8", APP_CSS);
    return;
  }
  if (req.method === "GET" && path === "/app.js") {
    send(res, 200, "text/javascript; charset=utf-8", APP_JS);
    return;
  }
  // The command reference is deliberately readable without the session
  // token: documentation must work before, and without, connecting an
  // account. It contains nothing about the user.
  if (req.method === "GET" && path === "/api/commands") {
    sendJson(res, 200, commandReference());
    return;
  }

  if (!path.startsWith("/api/")) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  if (!authorized(req, token)) {
    sendJson(res, 401, { error: "This page's session has expired. Restart `gmail ui`." });
    return;
  }

  try {
    await handleApi(req, res, path, session);
  } catch (error) {
    if (error instanceof UiError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    throw error;
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, session: UiSession): Promise<void> {
  if (req.method === "GET" && path === "/api/status") {
    sendJson(res, 200, await session.status());
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const body = await readJsonBody(req);

  switch (path) {
    case "/api/connect": {
      session.startConnect(typeof body["timezone"] === "string" ? body["timezone"] : null);
      sendJson(res, 202, await session.status());
      return;
    }
    case "/api/connect/cancel": {
      session.cancelCurrentConnect();
      sendJson(res, 200, await session.status());
      return;
    }
    case "/api/disconnect": {
      await session.disconnect(body["removeHistory"] === true);
      sendJson(res, 200, await session.status());
      return;
    }
    case "/api/ai": {
      const choice = body["choice"];
      if (choice !== "managed" && choice !== "api-key" && choice !== "off") {
        throw new UiError("Unknown AI option.", 400);
      }
      const apiKey = typeof body["apiKey"] === "string" && body["apiKey"].trim() ? body["apiKey"].trim() : null;
      await session.setAiAccess(choice as AiAccessId, apiKey);
      sendJson(res, 200, await session.status());
      return;
    }
    case "/api/preview": {
      session.startWork({ dryRun: true, limit: positiveIntOrUndefined(body["limit"]) });
      sendJson(res, 202, await session.status());
      return;
    }
    case "/api/run": {
      // A cleanup only ever starts from an explicit confirmation in the
      // page, never as a side effect of finishing sign-in or of viewing a
      // preview. The flag makes that impossible to get wrong by accident.
      if (body["confirm"] !== true) {
        throw new UiError("A cleanup must be confirmed explicitly.", 400);
      }
      session.startWork({ dryRun: false, limit: positiveIntOrUndefined(body["limit"]) });
      sendJson(res, 202, await session.status());
      return;
    }
    default:
      sendJson(res, 404, { error: "Not found." });
  }
}

function positiveIntOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "");
  return ALLOWED_HOSTNAMES.has(hostname);
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  // A same-origin GET typically sends no Origin at all; only reject one
  // that is present and belongs to someone else.
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ALLOWED_HOSTNAMES.has(parsed.hostname) && parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer);
    total += buffer.length;
    // Nothing this API accepts is large; a big body is a mistake or an abuse.
    if (total > 64 * 1024) throw new UiError("Request body too large.", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new UiError("Request body was not valid JSON.", 400);
  }
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    // No inline script or style, no external anything, no framing, and no
    // referrer — the page is entirely self-contained and must stay that way.
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}
