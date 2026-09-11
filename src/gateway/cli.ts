#!/usr/bin/env node
import { resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_COMPOSE_MODEL, DEFAULT_MODEL } from "../config/schema.js";
import { parseAccessList } from "./access.js";
import { startManagedAiGateway } from "./server.js";

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  GMAIL_AGENT_GATEWAY_GOOGLE_CLIENT_ID: z.string().endsWith(".apps.googleusercontent.com"),
  GMAIL_AGENT_GATEWAY_SUBJECT_HMAC_KEY: z.string().min(32),
  GMAIL_AGENT_GATEWAY_DB: z.string().min(1).default("./data/ai-gateway.sqlite"),
  GMAIL_AGENT_GATEWAY_ALLOWED_MODELS: z.string().default(`${DEFAULT_MODEL},${DEFAULT_COMPOSE_MODEL}`),
  GMAIL_AGENT_GATEWAY_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(120),
  GMAIL_AGENT_GATEWAY_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(2500),
  /** Beta audience: comma-separated `person@example.com` or `@example.com` entries. Empty means open. */
  GMAIL_AGENT_GATEWAY_ALLOWED_ACCOUNTS: z.string().default(""),
  GMAIL_AGENT_GATEWAY_BLOCKED_ACCOUNTS: z.string().default(""),
  /** When set, `GET /metrics` requires this bearer token. */
  GMAIL_AGENT_GATEWAY_METRICS_TOKEN: z.string().min(16).optional(),
  GMAIL_AGENT_GATEWAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  GMAIL_AGENT_GATEWAY_MAX_CONNECTIONS: z.coerce.number().int().positive().default(256),
  GMAIL_AGENT_GATEWAY_SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(15_000),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787)
});

async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env);
  const access = {
    allow: parseAccessList(env.GMAIL_AGENT_GATEWAY_ALLOWED_ACCOUNTS),
    block: parseAccessList(env.GMAIL_AGENT_GATEWAY_BLOCKED_ACCOUNTS)
  };
  const handle = await startManagedAiGateway({
    openAiApiKey: env.OPENAI_API_KEY,
    googleOAuthClientId: env.GMAIL_AGENT_GATEWAY_GOOGLE_CLIENT_ID,
    subjectHmacKey: env.GMAIL_AGENT_GATEWAY_SUBJECT_HMAC_KEY,
    databasePath: resolve(env.GMAIL_AGENT_GATEWAY_DB),
    allowedModels: env.GMAIL_AGENT_GATEWAY_ALLOWED_MODELS.split(",").map((model) => model.trim()).filter(Boolean),
    requestsPerMinute: env.GMAIL_AGENT_GATEWAY_REQUESTS_PER_MINUTE,
    requestsPerDay: env.GMAIL_AGENT_GATEWAY_REQUESTS_PER_DAY,
    access,
    metricsToken: env.GMAIL_AGENT_GATEWAY_METRICS_TOKEN,
    requestTimeoutMs: env.GMAIL_AGENT_GATEWAY_REQUEST_TIMEOUT_MS,
    maxConnections: env.GMAIL_AGENT_GATEWAY_MAX_CONNECTIONS,
    shutdownGraceMs: env.GMAIL_AGENT_GATEWAY_SHUTDOWN_GRACE_MS,
    host: env.HOST,
    port: env.PORT
  });
  // Counts only: an address here would put user identity into the service log.
  console.log(
    `Managed AI gateway listening at ${handle.url} ` +
      `(audience: ${access.allow.length === 0 ? "all signed-in Google accounts" : `${access.allow.length} allowlist entr${access.allow.length === 1 ? "y" : "ies"}`}` +
      `${access.block.length > 0 ? `, ${access.block.length} blocked` : ""})`
  );

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Drain in flight work first: severing a call already sent to OpenAI bills
    // a completion the user never receives.
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
