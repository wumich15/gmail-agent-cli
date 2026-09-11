import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { decideAccess, type GatewayAccessPolicy } from "./access.js";
import {
  defaultGatewayLogger,
  GatewayMetrics,
  type GatewayLogger,
  type GatewayOutcome
} from "./observability.js";
import { GatewayQuota, GatewayQuotaExceededError } from "./quota.js";

const MAX_REQUEST_BYTES = 96 * 1024;

/**
 * Transport limits. These exist so a slow or hostile client cannot occupy a
 * connection indefinitely on a single-instance deployment; infrastructure-level
 * limits in front of the gateway are still expected (see docs/production.md).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 20_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 256;
/** How long `close()` lets in-flight GPT calls finish before connections are cut. */
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;

const GatewayResponseRequestSchema = z
  .object({
    model: z.string().min(1).max(100),
    instructions: z.string().max(16_000).optional(),
    input: z.union([
      z.string().max(64_000),
      z.array(
        z
          .object({
            role: z.enum(["user", "assistant", "developer", "system"]),
            content: z.string().max(32_000)
          })
          .strict()
      ).max(32)
    ]),
    store: z.literal(false),
    text: z.object({ format: z.record(z.unknown()) }).strict().optional(),
    reasoning: z.object({ effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]) }).strict().optional(),
    max_output_tokens: z.number().int().min(1).max(2_000).optional()
  })
  .strict();

type GatewayResponseRequest = z.infer<typeof GatewayResponseRequestSchema>;

interface ResponsesClient {
  responses: {
    create(body: Record<string, unknown>): Promise<unknown>;
  };
}

export interface GatewayIdentity {
  subject: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
}

export interface ManagedAiGatewayOptions {
  openAiApiKey?: string;
  googleOAuthClientId: string;
  subjectHmacKey: string;
  databasePath: string;
  allowedModels: readonly string[];
  requestsPerMinute?: number;
  requestsPerDay?: number;
  host?: string;
  port?: number;
  /** Beta audience control; omit for general availability. */
  access?: GatewayAccessPolicy;
  /** When set, `GET /metrics` requires this bearer token. */
  metricsToken?: string | undefined;
  requestTimeoutMs?: number;
  maxConnections?: number;
  shutdownGraceMs?: number;
  log?: GatewayLogger;
  client?: ResponsesClient;
  verifyIdentity?: (idToken: string) => Promise<GatewayIdentity>;
}

export interface ManagedAiGatewayHandle {
  server: Server;
  url: string;
  metrics: GatewayMetrics;
  close(): Promise<void>;
}

class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly outcome: GatewayOutcome,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
}

/**
 * Authenticated, deliberately narrow Responses API gateway. It accepts only
 * the text-only request shape this app emits, forces `store:false`, caps
 * output, permits configured models only, and applies persistent per-user
 * quotas before spending publisher OpenAI credits.
 */
export function startManagedAiGateway(options: ManagedAiGatewayOptions): Promise<ManagedAiGatewayHandle> {
  if (options.subjectHmacKey.length < 32) throw new Error("subjectHmacKey must be at least 32 characters.");
  if (options.allowedModels.length === 0) throw new Error("At least one allowed GPT model is required.");

  const openai = options.client
    ? null
    : new OpenAI({
        apiKey: options.openAiApiKey,
        maxRetries: 0
      });
  const client: ResponsesClient =
    options.client ??
    ({
      responses: {
        create: (body: Record<string, unknown>) => openai!.responses.create(body as never)
      }
    } satisfies ResponsesClient);
  const google = new OAuth2Client();
  const verifyIdentity =
    options.verifyIdentity ??
    (async (idToken: string): Promise<GatewayIdentity> => {
      const ticket = await google.verifyIdToken({ idToken, audience: options.googleOAuthClientId });
      const payload = ticket.getPayload();
      if (!payload?.sub) throw new GatewayHttpError(401, "Google identity could not be verified.", "unauthenticated");
      return { subject: payload.sub, email: payload.email, emailVerified: payload.email_verified };
    });
  const allowedModels = new Set(options.allowedModels);
  const quota = new GatewayQuota({
    databasePath: options.databasePath,
    requestsPerMinute: options.requestsPerMinute ?? 120,
    requestsPerDay: options.requestsPerDay ?? 2_500
  });
  const metrics = new GatewayMetrics();
  const log = options.log ?? defaultGatewayLogger;
  const deps: RequestDeps = {
    options,
    client,
    verifyIdentity,
    allowedModels,
    quota,
    metrics,
    access: options.access ?? { allow: [], block: [] },
    draining: { value: false }
  };

  const server = createServer((req, res) => {
    const startedAtMs = Date.now();
    const requestId = randomUUID();
    const context: RequestContext = { requestId, route: routeLabel(req), outcome: "internal_error" };
    metrics.requestStarted();
    res.setHeader("x-request-id", requestId);
    const finish = (status: number): void => {
      const durationMs = Date.now() - startedAtMs;
      metrics.requestFinished({ route: context.route, status, outcome: context.outcome, durationMs });
      log({
        event: "gateway_request",
        requestId,
        method: req.method ?? "UNKNOWN",
        route: context.route,
        status,
        outcome: context.outcome,
        durationMs,
        ...(context.model ? { model: context.model } : {}),
        ...(context.subjectHash ? { subjectPrefix: context.subjectHash.slice(0, 12) } : {})
      });
    };
    res.once("close", () => finish(res.statusCode));
    handleRequest(req, res, deps, context).catch((error: unknown) => {
      sendGatewayError(res, error, context);
    });
  });
  server.requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(DEFAULT_HEADERS_TIMEOUT_MS, server.requestTimeout);
  server.keepAliveTimeout = DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  return new Promise((resolve, reject) => {
    const rejectAndClose = (error: Error) => {
      quota.close();
      reject(error);
    };
    server.once("error", rejectAndClose);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", rejectAndClose);
      const address = server.address() as AddressInfo;
      resolve({
        server,
        metrics,
        url: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
        close: () => shutdown(server, deps, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS)
      });
    });
  });
}

/**
 * Stops accepting new work, lets requests already talking to OpenAI finish
 * within the grace window, then closes hard. Cutting an in-flight request
 * would bill a completion the user never receives.
 */
async function shutdown(server: Server, deps: RequestDeps, graceMs: number): Promise<void> {
  deps.draining.value = true;
  const closed = new Promise<void>((done) => server.close(() => done()));
  const deadline = Date.now() + graceMs;
  while (deps.metrics.pendingRequests > 0 && Date.now() < deadline) {
    await new Promise((wake) => setTimeout(wake, 50));
  }
  server.closeAllConnections();
  await closed;
  deps.quota.close();
}

interface RequestContext {
  requestId: string;
  route: string;
  outcome: GatewayOutcome;
  model?: string;
  subjectHash?: string;
}

interface RequestDeps {
  options: ManagedAiGatewayOptions;
  client: ResponsesClient;
  verifyIdentity: (idToken: string) => Promise<GatewayIdentity>;
  allowedModels: Set<string>;
  quota: GatewayQuota;
  metrics: GatewayMetrics;
  access: GatewayAccessPolicy;
  draining: { value: boolean };
}

/** Only fixed, known paths are ever used as a metric label, so a URL cannot create unbounded series. */
function routeLabel(req: IncomingMessage): string {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/health" || path === "/metrics" || path === "/v1/responses") return path;
  return "other";
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RequestDeps,
  context: RequestContext
): Promise<void> {
  if (req.method === "GET" && context.route === "/health") {
    context.outcome = "health";
    sendJson(res, deps.draining.value ? 503 : 200, { ok: !deps.draining.value });
    return;
  }
  if (req.method === "GET" && context.route === "/metrics") {
    requireMetricsAuthorization(req, deps);
    context.outcome = "metrics";
    sendText(res, 200, deps.metrics.render());
    return;
  }
  if (req.method !== "POST" || context.route !== "/v1/responses") {
    throw new GatewayHttpError(404, "Not found.", "not_found");
  }
  if (deps.draining.value) {
    throw new GatewayHttpError(503, "The included AI service is restarting. Please try again.", "shutting_down", 5);
  }

  const authorization = req.headers.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) {
    throw new GatewayHttpError(401, "Google sign-in is required.", "unauthenticated");
  }
  const idToken = authorization.slice("Bearer ".length);
  let identity: GatewayIdentity;
  try {
    identity = await deps.verifyIdentity(idToken);
  } catch (error) {
    if (error instanceof GatewayHttpError) throw error;
    throw new GatewayHttpError(401, "Google identity could not be verified.", "unauthenticated");
  }

  const decision = decideAccess(deps.access, identity);
  if (decision !== "allowed") {
    throw new GatewayHttpError(
      403,
      decision === "blocked"
        ? "This account cannot use the included AI service."
        : "The included AI service is currently limited to invited accounts.",
      "forbidden"
    );
  }

  const raw = await readJson(req);
  const parsed = GatewayResponseRequestSchema.safeParse(raw);
  if (!parsed.success) throw new GatewayHttpError(400, "Unsupported AI request shape.", "invalid_request");
  const request = parsed.data;
  if (!deps.allowedModels.has(request.model)) {
    throw new GatewayHttpError(400, "That GPT model is not enabled.", "invalid_request");
  }
  context.model = request.model;

  const subjectHash = createHmac("sha256", deps.options.subjectHmacKey).update(identity.subject).digest("hex");
  context.subjectHash = subjectHash;
  try {
    deps.quota.reserve(subjectHash);
  } catch (error) {
    if (error instanceof GatewayQuotaExceededError) {
      throw new GatewayHttpError(429, error.message, "quota_exceeded", error.retryAfterSeconds);
    }
    throw error;
  }

  const upstreamRequest: Record<string, unknown> = {
    model: request.model,
    input: request.input,
    store: false,
    max_output_tokens: request.max_output_tokens ?? (request.text ? 600 : 1_500),
    safety_identifier: subjectHash,
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
    ...(request.text !== undefined ? { text: request.text } : {}),
    ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {})
  };

  try {
    const response = await deps.client.responses.create(upstreamRequest);
    context.outcome = "ok";
    sendJson(res, 200, response);
  } catch {
    // Never relay upstream headers, request details, or provider diagnostics.
    throw new GatewayHttpError(502, "The included AI service is temporarily unavailable.", "upstream_error");
  }
}

function requireMetricsAuthorization(req: IncomingMessage, deps: RequestDeps): void {
  const expected = deps.options.metricsToken;
  if (!expected) return;
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new GatewayHttpError(401, "Metrics require a bearer token.", "unauthenticated");
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new GatewayHttpError(413, "AI request is too large.", "too_large"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new GatewayHttpError(400, "Request body must be valid JSON.", "invalid_request"));
      }
    });
    req.on("error", reject);
  });
}

function sendGatewayError(res: ServerResponse, error: unknown, context: RequestContext): void {
  const status = error instanceof GatewayHttpError ? error.status : 500;
  context.outcome = error instanceof GatewayHttpError ? error.outcome : "internal_error";
  if (res.headersSent || res.destroyed) return;
  const message = error instanceof GatewayHttpError ? error.message : "The AI service encountered an error.";
  if (error instanceof GatewayHttpError && error.retryAfterSeconds !== undefined) {
    res.setHeader("retry-after", String(error.retryAfterSeconds));
  }
  sendJson(res, status, {
    error: {
      message,
      type:
        status === 429
          ? "rate_limit_error"
          : status === 401 || status === 403
            ? "authentication_error"
            : status >= 500
              ? "server_error"
              : "invalid_request_error",
      code: status === 429 ? "managed_ai_quota_exceeded" : undefined
    }
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBody(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  sendBody(res, status, "text/plain; version=0.0.4; charset=utf-8", body);
}

function sendBody(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

export type { GatewayResponseRequest };
