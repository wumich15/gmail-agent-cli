/**
 * Release-embedded publisher configuration: the Google Desktop OAuth client,
 * the hosted setup/disclosure page, the authenticated AI gateway, and the
 * Firebase Web API key used to exchange a one-time custom token for a
 * refreshable gateway session.
 *
 * Why any of this is embedded at all: the product requirement (see
 * `openrouter.md`) is that a normal user installs the package, runs `gmail
 * setup`, completes exactly one Google consent, and is done — no Cloud
 * project, no credentials file, no AI-provider account, no pasted key. That
 * is only possible if the release build already knows which OAuth client to
 * authorize against and which service to ask for AI.
 *
 * None of these values is a security boundary:
 *
 * - An installed-app client ID/secret is explicitly not confidential; Google
 *   says so for the native-app flow, which is why `google-oauth.ts` also
 *   requires PKCE S256, a random `state`, an OIDC nonce, and a loopback-only
 *   redirect that only this machine can receive.
 * - The gateway URL is public by construction. Every request to it carries a
 *   short-lived Firebase ID token, is checked against a stored consent
 *   receipt and per-user quota, and can only invoke two typed operations —
 *   it is never a general-purpose model relay (see `src/gateway/`).
 * - The Firebase Web API key is a project identifier, not a credential.
 *
 * What must never be embedded is a model-provider key. `scripts/verify-package.mjs`
 * fails the release if one appears in the packed tarball.
 *
 * The source tree deliberately holds markers rather than real values, so a
 * developer's own Cloud project can never be published by accident.
 * `scripts/embed-release-config.mjs` replaces them in `dist/` from the
 * publisher's secret-managed build environment. Until it does — and in every
 * source checkout — these resolve to empty and the CLI says plainly that this
 * build has no publisher configuration rather than pretending a zero-setup
 * onboarding path exists.
 */

const OAUTH_CLIENT_ID_MARKER = "__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID__";
const OAUTH_CLIENT_SECRET_MARKER = "__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET__";
const SETUP_PAGE_URL_MARKER = "__GMAIL_AGENT_PUBLISHER_SETUP_PAGE_URL__";
const AI_GATEWAY_URL_MARKER = "__GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL__";
const FIREBASE_API_KEY_MARKER = "__GMAIL_AGENT_PUBLISHER_FIREBASE_API_KEY__";

function embedded(value: string): string {
  return value.startsWith("__GMAIL_AGENT_PUBLISHER_") ? "" : value;
}

export const PUBLISHER_OAUTH_CLIENT_ID = embedded(OAUTH_CLIENT_ID_MARKER);
export const PUBLISHER_OAUTH_CLIENT_SECRET = embedded(OAUTH_CLIENT_SECRET_MARKER);
export const PUBLISHER_SETUP_PAGE_URL = embedded(SETUP_PAGE_URL_MARKER);
export const PUBLISHER_AI_GATEWAY_URL = embedded(AI_GATEWAY_URL_MARKER);
export const PUBLISHER_FIREBASE_API_KEY = embedded(FIREBASE_API_KEY_MARKER);

/**
 * The exact disclosure the user accepted, recorded with every consent
 * receipt. The gateway refuses message text from a client whose stored
 * receipt names a different version, so a materially changed data policy
 * forces re-consent instead of silently inheriting the old one. Bump this
 * whenever `/connect`'s hosted-AI paragraph changes in substance.
 */
export const HOSTED_AI_POLICY_VERSION = "hosted-ai-2026-09-12";

export interface PublisherOAuthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * The publisher's Desktop OAuth client, or null in a source/development
 * build. Environment variables win so a staging project can be exercised
 * without rebuilding.
 */
export function resolvePublisherOAuthClient(
  env: NodeJS.ProcessEnv = process.env
): PublisherOAuthClient | null {
  const clientId = env["GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID"] ?? PUBLISHER_OAUTH_CLIENT_ID;
  const clientSecret = env["GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET"] ?? PUBLISHER_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Base URL of the hosted disclosure/setup page, without a trailing slash. */
export function resolveSetupPageUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env["GMAIL_AGENT_SETUP_PAGE_URL"] ?? PUBLISHER_SETUP_PAGE_URL;
  if (!raw) return null;
  return normalizeServiceUrl(raw, "setup page");
}

export interface HostedAiService {
  /** HTTPS origin (plus any path prefix) of the gateway, without a trailing slash. */
  baseUrl: string;
  /** Firebase Web API key for the custom-token and refresh-token exchanges. */
  firebaseApiKey: string;
  source: "publisher" | "environment";
}

/**
 * The publisher-operated AI service, or null when this build has none.
 *
 * Both halves are required: without the gateway URL there is nothing to
 * call, and without the Firebase Web API key the CLI cannot turn the
 * gateway's one-time custom token into a session it can refresh. Returning
 * null for a half-configured build is deliberate — a partially wired hosted
 * mode that fails on the first classify call is worse than an honest
 * "this build has no hosted AI".
 */
export function resolveHostedAiService(env: NodeJS.ProcessEnv = process.env): HostedAiService | null {
  const envUrl = env["GMAIL_AGENT_AI_GATEWAY_URL"];
  const envKey = env["GMAIL_AGENT_FIREBASE_API_KEY"];
  if (envUrl && envKey) {
    return { baseUrl: normalizeServiceUrl(envUrl, "AI gateway"), firebaseApiKey: envKey, source: "environment" };
  }
  if (PUBLISHER_AI_GATEWAY_URL && PUBLISHER_FIREBASE_API_KEY) {
    return {
      baseUrl: normalizeServiceUrl(PUBLISHER_AI_GATEWAY_URL, "AI gateway"),
      firebaseApiKey: PUBLISHER_FIREBASE_API_KEY,
      source: "publisher"
    };
  }
  return null;
}

/**
 * HTTPS everywhere except loopback, which stays reachable so the gateway can
 * be run locally during development without weakening the released default.
 * Query strings and fragments are dropped: nothing about addressing this
 * service belongs in one, and silently carrying a stray token there into
 * every request would be exactly the kind of leak this app avoids elsewhere.
 */
export function normalizeServiceUrl(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`The ${label} URL is not a valid URL.`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`The ${label} must use HTTPS (HTTP is allowed only on loopback, for development).`);
  }
  if (url.username || url.password) {
    throw new Error(`The ${label} URL must not contain credentials.`);
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** True when this build can complete the documented one-consent onboarding. */
export function publisherOnboardingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePublisherOAuthClient(env) !== null;
}

/**
 * True when a user could actually *turn on* the included AI service.
 *
 * All three parts are required, because the hosted session is minted from the
 * Google ID token that consent produces, and that consent only carries the
 * identity scope and the disclosure when the sign-in runs through the
 * publisher's client and page. A build with a gateway but no setup page could
 * offer the option and never be able to connect it — the user would accept a
 * disclosure, and every run would still fall back to rules only.
 *
 * `scripts/embed-release-config.mjs` requires all three together, so this is a
 * guard against a misconfigured build rather than a path a real release takes.
 * An install that *already* has a session keeps working on the gateway alone
 * (see `ai/resolve-classifier.ts`); this only governs whether the option is
 * offered in the first place.
 */
export function hostedOnboardingAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    resolvePublisherOAuthClient(env) !== null &&
    resolveSetupPageUrl(env) !== null &&
    resolveHostedAiService(env) !== null
  );
}
