import { HOSTED_CONTRACT_VERSION } from "../../src/ai/hosted-contract.js";

/**
 * Every operational decision the gateway makes, resolved from the runtime
 * environment in one place so a deployment can be read off a single file.
 *
 * Two rules govern what may appear here:
 *
 * - The provider API key is read from Secret Manager at runtime and is never
 *   returned in a response, written to a log, or exposed through any endpoint.
 * - The model and its provider route are pinned by the *service*, never
 *   chosen by a caller. That is the difference between "an AI feature the
 *   publisher funds" and "subsidized general-purpose inference anyone can
 *   point at any model".
 */

export interface GatewayConfig {
  /** Exact audience a Google ID token must carry: the publisher's Desktop OAuth client. */
  googleOAuthClientId: string;
  /** HMAC key that turns Google's `sub` into a pseudonymous user ID. From Secret Manager. */
  userIdHmacKey: string;
  /** The disclosure version a consent receipt must name before message text is accepted. */
  policyVersion: string;
  provider: ProviderConfig;
  quota: QuotaConfig;
  /** Pseudonymous user IDs allowed during a closed beta. Empty means generally available. */
  betaAllowList: readonly string[];
  /** Turns every AI operation off without a redeploy. The documented incident control. */
  killSwitch: boolean;
  /** Shown to the CLI after a successful bootstrap, e.g. "200 messages/day". */
  allowanceDescription: string;
}

export interface ProviderConfig {
  /** Responses-API-compatible base URL of the approved model service. */
  baseUrl: string;
  apiKey: string;
  /**
   * Pinned model snapshots, one per operation. A moving alias is acceptable
   * only in development: a release must be able to say exactly which model
   * passed the evaluation gates, and the CLI's assessment cache is keyed on
   * the contract version that pins them.
   */
  classifyModel: string;
  draftModel: string;
  /**
   * OpenRouter-style privacy routing, sent with every request when enabled.
   *
   * These are necessary but not sufficient for Gmail content: they govern
   * *upstream* provider handling, and per OpenRouter's published data-collection
   * documentation they do not by themselves disable OpenRouter's own sampling
   * of a small number of prompts for anonymous categorization. Routing Gmail
   * data through that service additionally requires a written, enforceable
   * opt-out from that secondary use — see docs/launch/decisions.md. This flag
   * exists so the technical half is never the thing that was forgotten.
   */
  requireZeroDataRetention: boolean;
  denyUpstreamDataCollection: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface QuotaConfig {
  requestsPerMinute: number;
  requestsPerDay: number;
  requestsPerMonth: number;
}

class MissingSettingError extends Error {
  constructor(name: string) {
    super(`The gateway is missing required setting ${name}. Refusing to start.`);
    this.name = "MissingSettingError";
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new MissingSettingError(name);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new MissingSettingError(name);
  return parsed;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const model = required(env, "GATEWAY_CLASSIFY_MODEL");
  return {
    googleOAuthClientId: required(env, "GATEWAY_GOOGLE_OAUTH_CLIENT_ID"),
    userIdHmacKey: required(env, "USER_ID_HMAC_KEY"),
    policyVersion: required(env, "GATEWAY_POLICY_VERSION"),
    provider: {
      baseUrl: required(env, "GATEWAY_PROVIDER_BASE_URL").replace(/\/$/, ""),
      apiKey: required(env, "GATEWAY_PROVIDER_API_KEY"),
      classifyModel: model,
      draftModel: env["GATEWAY_DRAFT_MODEL"] ?? model,
      // Default on. A deployment that cannot obtain a compliant route should
      // fail the request, not quietly fall back to a weaker one.
      requireZeroDataRetention: env["GATEWAY_PROVIDER_ZDR"] !== "false",
      denyUpstreamDataCollection: env["GATEWAY_PROVIDER_DENY_COLLECTION"] !== "false",
      timeoutMs: integer(env, "GATEWAY_PROVIDER_TIMEOUT_MS", 30_000),
      maxOutputTokens: integer(env, "GATEWAY_MAX_OUTPUT_TOKENS", 1_200)
    },
    quota: {
      requestsPerMinute: integer(env, "GATEWAY_QUOTA_PER_MINUTE", 60),
      requestsPerDay: integer(env, "GATEWAY_QUOTA_PER_DAY", 500),
      requestsPerMonth: integer(env, "GATEWAY_QUOTA_PER_MONTH", 5_000)
    },
    betaAllowList: list(env["GATEWAY_BETA_ALLOW_LIST"]),
    killSwitch: env["GATEWAY_DISABLED"] === "true",
    allowanceDescription:
      env["GATEWAY_ALLOWANCE_DESCRIPTION"] ??
      `${integer(env, "GATEWAY_QUOTA_PER_DAY", 500)} AI requests per day (fair use)`
  };
}

/** The only contract version this deployment serves. */
export const SERVED_CONTRACT_VERSION = HOSTED_CONTRACT_VERSION;
