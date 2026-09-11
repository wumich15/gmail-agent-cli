/**
 * The publisher-managed Google OAuth *installed-app* client shipped with a
 * release build, so a user only has to press "Connect Gmail" — they never
 * create a Cloud project, enable APIs, or download a credentials file.
 *
 * An installed-app client secret is not confidential. Google says so
 * directly for the native-app flow, which is why this flow additionally
 * requires PKCE S256, a random `state`, and a loopback redirect that only
 * this machine can receive (see `google-oauth.ts`). Publishing these values
 * in the package is therefore expected, not a leak — but it also means the
 * client identity must never be treated as a security boundary, and every
 * real authorization decision stays with Google's consent screen and the
 * user's own account.
 *
 * These are marker-only in the source tree on purpose. A release build
 * fills them from the publisher's secret-managed build environment — and until it does,
 * `resolveOAuthClientCredentials` falls back to the developer environment
 * variables and says exactly that when neither is available, rather than
 * pretending a consumer sign-in path exists.
 */
/**
 * Release markers are replaced in `dist/` by scripts/embed-release-config.mjs.
 * Keeping the source tree marker-only prevents a developer OAuth project from
 * being published accidentally, while still producing a self-contained npm
 * package for end users. Do not change these strings without changing that
 * script as well.
 */
const PUBLISHER_OAUTH_CLIENT_ID_MARKER = "__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID__";
const PUBLISHER_OAUTH_CLIENT_SECRET_MARKER = "__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET__";
const PUBLISHER_AI_GATEWAY_URL_MARKER = "__GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL__";

function embeddedValue(value: string): string {
  return value.startsWith("__GMAIL_AGENT_PUBLISHER_") ? "" : value;
}

export const PUBLISHER_OAUTH_CLIENT_ID = embeddedValue(PUBLISHER_OAUTH_CLIENT_ID_MARKER);
export const PUBLISHER_OAUTH_CLIENT_SECRET = embeddedValue(PUBLISHER_OAUTH_CLIENT_SECRET_MARKER);

/** HTTPS base URL of the publisher-operated, authenticated GPT gateway. */
export const PUBLISHER_AI_GATEWAY_URL = embeddedValue(PUBLISHER_AI_GATEWAY_URL_MARKER);

export function publisherOAuthClientConfigured(): boolean {
  return PUBLISHER_OAUTH_CLIENT_ID.length > 0 && PUBLISHER_OAUTH_CLIENT_SECRET.length > 0;
}

export interface ManagedAiGatewayConfig {
  /** OpenAI-compatible base URL, always ending in `/v1`. */
  baseURL: string;
  source: "publisher" | "environment";
}

function normalizeGatewayUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error("The managed AI gateway must use HTTPS (HTTP is allowed only on loopback for development).");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1`.replace(/\/v1\/v1$/, "/v1");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Resolves the included AI service. The environment override is deliberately
 * a development/operator seam; consumer releases use the embedded URL.
 */
export function resolveManagedAiGateway(env: NodeJS.ProcessEnv = process.env): ManagedAiGatewayConfig | null {
  const environmentUrl = env["GMAIL_AGENT_AI_GATEWAY_URL"];
  if (environmentUrl) return { baseURL: normalizeGatewayUrl(environmentUrl), source: "environment" };
  if (PUBLISHER_AI_GATEWAY_URL) {
    return { baseURL: normalizeGatewayUrl(PUBLISHER_AI_GATEWAY_URL), source: "publisher" };
  }
  return null;
}
