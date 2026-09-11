import { CREDENTIAL_KEYS, type CredentialStore } from "../auth/credential-store.js";
import {
  DEFAULT_COMPOSE_MODEL,
  DEFAULT_MODEL,
  type AiProvider,
  type Config
} from "../config/schema.js";
import { NotConfiguredClassifier } from "./not-configured-classifier.js";
import { OpenAiClassifier } from "./openai-classifier.js";
import { SCHEMA_VERSION } from "./assessment-mapping.js";
import { PROMPT_VERSION } from "./prompt.js";
import { googleIdTokenFromRefreshToken, resolveOAuthClientCredentials } from "../auth/google-oauth.js";
import { resolveManagedAiGateway } from "../auth/publisher-client.js";
import type { Classifier } from "./classifier.js";

export interface ResolveClassifierInput {
  accountHash: string;
  credentialStore: CredentialStore;
  config: Config | null;
  /** Test seam for the short-lived Google identity used by managed AI. */
  managedIdentityToken?: (() => Promise<string>) | undefined;
  /** Test seam; production resolves the URL embedded in the release. */
  managedGatewayBaseURL?: string | undefined;
}

export interface ResolvedClassifier {
  classifier: Classifier;
  /** Human-readable, printed to the user so it's always clear which mode a run used. */
  description: string;
  /**
   * The exact classifier/prompt/schema version identifiers this resolved
   * classifier would produce right now — passed straight through to
   * `core/orchestrator.ts`'s `OrchestratorDeps` so it can both label fresh
   * assessments correctly and recognize a still-valid cached one (see
   * `OrchestratorDeps.cachedAssessments`). All three are the fixed
   * `"not-configured"` placeholder for `NotConfiguredClassifier`, which
   * guarantees a cached row (always carrying a real provider-prefixed
   * version) can never spuriously match it. Switching providers changes
   * the prefix, which correctly invalidates assessments made by the other.
   */
  classifierVersion: string;
  promptVersion: string;
  schemaVersion: string;
}

export interface ResolvedAiCredentials {
  provider: AiProvider;
  /** Google ID token for managed AI, otherwise the user's provider key. */
  apiKey: string;
  model: string;
  baseURL: string | null;
}

const managedTokenCache = new Map<string, { token: string; expiresAt: number }>();

function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function resolveManagedIdentityToken(input: ResolveClassifierInput): Promise<string | null> {
  if (input.managedIdentityToken) return input.managedIdentityToken();

  const cached = managedTokenCache.get(input.accountHash);
  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;

  const refreshToken = await input.credentialStore.getSecret(CREDENTIAL_KEYS.oauthRefreshToken(input.accountHash));
  if (!refreshToken) return null;
  const token = await googleIdTokenFromRefreshToken(resolveOAuthClientCredentials(), refreshToken);
  managedTokenCache.set(input.accountHash, { token, expiresAt: jwtExpiry(token) });
  return token;
}

/** @deprecated Kept for older call sites; the resolution is no longer OpenAI-specific. */
export type ResolvedOpenAiCredentials = ResolvedAiCredentials;

/**
 * Which job the model is being resolved for. These are deliberately
 * different models on a hosted provider: `classify` runs a cheap call on
 * every unresolved message, while `compose` drafts prose the user will
 * read, edit, and send under their own name. See `config/schema.ts` for
 * the two defaults.
 */
export type ModelPurpose = "classify" | "compose";

function resolveModel(input: ResolveClassifierInput, purpose: ModelPurpose, fallback: string): string {
  // GMAIL_AGENT_MODEL / GMAIL_AGENT_COMPOSE_MODEL are documented as live
  // overrides (CLAUDE.md's "Firm technology decisions" table), so they must
  // win over whatever model got persisted into config.json at an earlier
  // sign-in — a config file happily keeps a stale model name forever
  // otherwise, since nothing else ever rewrites it.
  const override = purpose === "compose" ? process.env["GMAIL_AGENT_COMPOSE_MODEL"] : process.env["GMAIL_AGENT_MODEL"];
  const configured = purpose === "compose" ? input.config?.composeModel : input.config?.model;
  return override || configured || fallback;
}

/**
 * Shared credential/model resolution used by classification and by `gmail
 * view`'s AI drafting, so the two never drift on which provider they end
 * up talking to — only the model differs, by `purpose`.
 *
 * Returns null when AI must not run at all: either the user turned it off
 * (`aiEnabled: false` — a real switch as of config schema v2), or the
 * selected provider needs a key and none is available. A null result is
 * always safe: the caller falls back to rules-only classification or to a
 * manually typed draft.
 */
export async function resolveAiCredentials(
  input: ResolveClassifierInput,
  purpose: ModelPurpose = "classify"
): Promise<ResolvedAiCredentials | null> {
  // An existing config file is the user's explicit choice and wins. A
  // missing config (never set up, or a headless environment-configured
  // run) falls through to "enabled if a provider resolves", which is what
  // this app did before the flag became meaningful.
  if (input.config && !input.config.aiEnabled) {
    return null;
  }

  const provider: AiProvider = input.config?.aiProvider ?? "openai";

  if (provider === "managed") {
    const gateway = input.managedGatewayBaseURL
      ? { baseURL: input.managedGatewayBaseURL }
      : resolveManagedAiGateway();
    if (!gateway) return null;
    const identityToken = await resolveManagedIdentityToken(input);
    if (!identityToken) return null;
    return {
      provider,
      apiKey: identityToken,
      model: resolveModel(input, purpose, purpose === "compose" ? DEFAULT_COMPOSE_MODEL : DEFAULT_MODEL),
      baseURL: gateway.baseURL
    };
  }

  // Hosted providers: checked in the OS credential store first, then the
  // OPENAI_API_KEY environment variable, matching how the OpenAI SDK
  // itself defaults.
  const storedKey = await input.credentialStore.getSecret(CREDENTIAL_KEYS.aiApiKey(input.accountHash));
  const apiKey = storedKey ?? process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    return null;
  }
  return {
    provider,
    apiKey,
    model: resolveModel(input, purpose, purpose === "compose" ? DEFAULT_COMPOSE_MODEL : DEFAULT_MODEL),
    baseURL: provider === "openai-compatible" && input.config?.aiBaseUrl ? input.config.aiBaseUrl : null
  };
}

/** @deprecated Renamed to `resolveAiCredentials`; kept so existing call sites keep working. */
export const resolveOpenAiCredentials = resolveAiCredentials;

/**
 * Resolves which classifier a run should use. Without a usable provider,
 * NotConfiguredClassifier keeps the pipeline safe: no AI-derived mutation,
 * deterministic rules and read-archiving only.
 */
export async function resolveClassifier(input: ResolveClassifierInput): Promise<ResolvedClassifier> {
  const credentials = await resolveAiCredentials(input);

  if (!credentials) {
    const off = input.config?.aiEnabled === false;
    return {
      classifier: new NotConfiguredClassifier(),
      description: off
        ? "AI classification is turned off — using rules-only mode."
        : "AI classification is not configured (no usable hosted provider found) — using rules-only mode.",
      classifierVersion: "not-configured",
      promptVersion: "not-configured",
      schemaVersion: "not-configured"
    };
  }

  return {
    classifier: new OpenAiClassifier({
      apiKey: credentials.apiKey,
      model: credentials.model,
      ...(credentials.baseURL !== null ? { baseURL: credentials.baseURL } : {}),
      assessmentProvider: credentials.provider === "managed" ? "managed" : "openai"
    }),
    description:
      credentials.provider === "managed"
        ? `Using included GPT classification (model: ${credentials.model}); no API key is required from you.`
        : `Using AI classification via ${credentials.baseURL ?? "the OpenAI API"} (model: ${credentials.model}).`,
    classifierVersion: `${credentials.provider === "managed" ? "managed" : "openai"}:${credentials.model}`,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION
  };
}
