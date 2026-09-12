import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { AuthRequiredError, InvalidConfigError } from "../core/errors.js";
import { openUrlInBrowser } from "../core/open-browser.js";
import { oauthClientFilePath, readStoredOAuthClient } from "./oauth-client-file.js";
import { resolvePublisherOAuthClient, resolveSetupPageUrl } from "./publisher-client.js";

/**
 * Restricted Gmail scope plus a narrow Calendar scope limited to events on
 * the user's own calendars. Requested together at initial consent because
 * installed apps do not reliably support incremental authorization.
 */
export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events.owned"
] as const;

/**
 * Requested only when this build has a hosted AI service to authenticate to.
 *
 * `openid` makes Google return an ID token in the same consent, which
 * `auth/hosted-session.ts` presents once to the gateway's
 * `/v1/session/bootstrap` to establish a separately revocable Firebase
 * session. It is deliberately not requested in a fully local build: there is
 * no service to prove an identity to, and the signed-in address already comes
 * from Gmail's own `users.getProfile`, which `gmail.modify` covers.
 *
 * `email` is *not* requested. The gateway identifies users by the stable
 * `sub` claim; an address would only add a piece of personal data the service
 * has no use for.
 */
export const OAUTH_IDENTITY_SCOPE = "openid";

const LOOPBACK_TIMEOUT_MS = 120_000;

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Where the OAuth installed-app client came from: the client this release
 * ships with, the one this tool saved during setup, or environment variables
 * (CI, or someone who prefers to keep it out of a file). Surfaced to `gmail
 * doctor` and the setup UI so "which Cloud project am I actually using" is
 * never a guess.
 */
export type OAuthClientSource = "stored" | "environment" | "publisher";

export interface ResolvedOAuthClient extends OAuthClientCredentials {
  source: OAuthClientSource;
}

/** Message shown whenever no OAuth client is available. Kept in one place so setup, doctor, and login agree. */
export const OAUTH_CLIENT_SETUP_HELP =
  "This build has no publisher Google app embedded and this computer has no saved one, so it cannot sign in.\n\n" +
  "A released build connects with one Google consent and nothing to configure. Running from a source checkout,\n" +
  "register a Desktop OAuth client in your own Google Cloud project instead:\n" +
  "  1. Open https://console.cloud.google.com/ and create a project (any name).\n" +
  "  2. Enable the Gmail API and the Google Calendar API.\n" +
  "  3. On the OAuth consent screen, choose External, add yourself as a test user,\n" +
  "     and add the scopes gmail.modify and calendar.events.owned.\n" +
  "  4. Under Clients, create an OAuth client of type Desktop app.\n" +
  "  5. Run `gmail setup` and paste the client ID and client secret it gives you.\n\n" +
  "See docs/setup.md for the walkthrough with screenshots of each field.";

/**
 * Resolves the installed-app OAuth client, in precedence order:
 *
 *  1. an explicit environment override (CI, staging, development);
 *  2. a client this user registered themselves and saved on this computer;
 *  3. the publisher client embedded in a release build.
 *
 * The user's own client outranks the publisher's on purpose: someone who went
 * to the trouble of registering a Cloud project has an advanced configuration
 * that a package upgrade must not silently take over — their mail would
 * abruptly start flowing through someone else's OAuth project and quota. A
 * fresh install has no saved client, so the ordinary path is the publisher's
 * and requires nothing of the user.
 *
 * Neither value is confidential (see `oauth-client-file.ts` and
 * `publisher-client.ts`), so this precedence is about which Cloud project is
 * in use, not about secrecy.
 */
export function resolveOAuthClientCredentials(env: NodeJS.ProcessEnv = process.env): ResolvedOAuthClient {
  const clientId = env["GMAIL_AGENT_OAUTH_CLIENT_ID"];
  const clientSecret = env["GMAIL_AGENT_OAUTH_CLIENT_SECRET"];
  if (clientId && clientSecret) {
    return { clientId, clientSecret, source: "environment" };
  }
  const stored = readStoredOAuthClient(env);
  if (stored) {
    return { ...stored, source: "stored" };
  }
  const publisher = resolvePublisherOAuthClient(env);
  if (publisher) {
    return { ...publisher, source: "publisher" };
  }
  throw new InvalidConfigError(OAUTH_CLIENT_SETUP_HELP);
}

/** Whether a client is available at all, without throwing — for status screens. */
export function oauthClientConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    resolveOAuthClientCredentials(env);
    return true;
  } catch {
    return false;
  }
}

export { oauthClientFilePath };

/**
 * True for the one Google OAuth failure that is not transient and not a
 * configuration mistake: the stored refresh token is no longer usable
 * (the user revoked access at myaccount.google.com, the grant expired —
 * seven days for a Testing-mode app using Gmail scopes — or the password
 * changed). The stored token must be erased and consent obtained again;
 * retrying the same token can only keep failing.
 */
export function isInvalidGrantError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { message?: unknown; response?: { data?: { error?: unknown } } };
  if (candidate.response?.data?.error === "invalid_grant") return true;
  return typeof candidate.message === "string" && candidate.message.includes("invalid_grant");
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Constant-time comparison for the two opaque values a browser hands back
 * (the OAuth `state` and the hosted page's bootstrap state). Both are
 * single-use and short-lived, so a timing oracle is a thin attack at best —
 * but these are the only two secrets the loopback listener checks, and
 * comparing them in constant time costs nothing.
 */
function secretEquals(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Google returned no refresh token, so this sign-in cannot be made durable.
 *
 * Its own class because it has exactly one correct recovery, and only once:
 * repeat the authorization with `prompt=consent`, which is the documented way
 * to make Google re-issue one. `core/connect.ts` does that a single time
 * rather than looping — a second failure means something is wrong that
 * another consent screen will not fix.
 */
export class MissingRefreshTokenError extends AuthRequiredError {
  constructor() {
    super(
      "Google did not return a refresh token, so this sign-in would not last. Re-run `gmail setup`; if this " +
        "keeps happening, revoke the app's access at https://myaccount.google.com/permissions and retry."
    );
    this.name = "MissingRefreshTokenError";
  }
}

/** What the user chose on the hosted disclosure page, or in the terminal. */
export type ConnectMode = "hosted-ai" | "rules-only";

export interface LoginResult {
  refreshToken: string;
  accessToken: string;
  /**
   * Google's OIDC ID token from the same consent, present only when
   * `OAUTH_IDENTITY_SCOPE` was requested. Used exactly once, to bootstrap a
   * gateway session; it is never stored and never sent anywhere else.
   */
  idToken: string | null;
  expiryDate: number | null;
  scopes: string[];
  /**
   * The AI mode the user selected on the hosted page. Null when there was no
   * hosted page in the flow (a local build, or a developer client), in which
   * case the caller asks in the terminal instead.
   */
  mode: ConnectMode | null;
}

export interface InstalledAppLoginOptions {
  /**
   * Adds `openid` to the consent so a Google ID token comes back. Set only
   * when a hosted AI service exists for that token to authenticate to.
   */
  requestIdentityScope?: boolean;
  /**
   * Base URL of the hosted disclosure page. When set, the browser opens that
   * page first and the user's choice comes back through the loopback
   * listener's `/begin` route; when unset, the browser goes straight to
   * Google's consent screen.
   */
  setupPageUrl?: string | null;
  /**
   * Forces Google's consent screen even when the user has approved before.
   * Used only to recover a genuinely missing refresh token — forcing it on
   * every login makes re-consent meaningless as a signal and trains users to
   * click through it.
   */
  forceConsent?: boolean;
}

/**
 * Runs the OAuth 2.0 installed-app flow: PKCE S256, a random `state`, an
 * OIDC `nonce`, and a loopback listener bound only to 127.0.0.1 on an
 * OS-assigned port. Closes the listener on success, error, or timeout, and
 * validates `state` and the exact callback path before exchanging the code.
 *
 * With a hosted setup page configured, the same listener first serves a
 * `/begin` handoff: the browser is sent to the disclosure page with the port
 * and a one-time bootstrap state in the URL *fragment* (never a query string,
 * so it stays out of the hosting server's logs and out of any referrer), the
 * page shows the disclosure, and the user's chosen mode arrives back here as
 * a plain navigation. The page never receives an authorization code, a token,
 * the PKCE verifier, or a callback URL it could redirect to — it hands back
 * two values this process generated and nothing else.
 */
export async function runInstalledAppLogin(
  credentials: OAuthClientCredentials,
  onAuthorizeUrl: (url: string) => void,
  options: InstalledAppLoginOptions = {}
): Promise<LoginResult> {
  const { verifier, challenge } = generatePkcePair();
  const state = base64Url(randomBytes(16));
  const nonce = base64Url(randomBytes(16));
  const bootstrapState = base64Url(randomBytes(16));
  const scopes = [...OAUTH_SCOPES, ...(options.requestIdentityScope ? [OAUTH_IDENTITY_SCOPE] : [])];

  const outcome = await new Promise<{ code: string; redirectUri: string; mode: ConnectMode | null }>(
    (resolve, reject) => {
      // Captured once the server starts listening. Reading it again from
      // server.address() after server.close() returns null — close() clears
      // the listening address immediately, before the 'close' event even
      // fires — so the callback handler reuses this instead.
      let redirectUri = "";
      let authorizeUrl = "";
      let selectedMode: ConnectMode | null = null;
      // The bootstrap state is single-use: a second /begin (a refresh, a back
      // button, a duplicate click) must not be able to restart the flow.
      let bootstrapConsumed = false;

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (url.pathname === "/begin") {
          if (bootstrapConsumed || !secretEquals(bootstrapState, url.searchParams.get("state"))) {
            // No technical detail: the page is told to send the user back to
            // `gmail setup`, which is the only recovery anyway.
            res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(
              page("This setup link is no longer valid. Return to your terminal and run `gmail setup` again.")
            );
            return;
          }
          bootstrapConsumed = true;
          const requested = url.searchParams.get("mode");
          selectedMode = requested === "hosted-ai" ? "hosted-ai" : "rules-only";
          res.writeHead(302, { location: authorizeUrl, "cache-control": "no-store" }).end();
          return;
        }

        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const returnedCode = url.searchParams.get("code");

        const finish = (body: string) => {
          res
            .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
            .end(page(body));
          server.close();
        };

        if (error) {
          finish(`Authorization failed: ${escapeHtml(error)}. You can close this tab.`);
          reject(new AuthRequiredError(`Google returned an OAuth error: ${error}`));
          return;
        }
        if (!secretEquals(state, returnedState) || !returnedCode) {
          finish("Invalid authorization response. You can close this tab.");
          reject(new AuthRequiredError("OAuth state mismatch or missing code; aborting for safety."));
          return;
        }
        finish("Signed in. You can close this tab and return to the terminal.");
        resolve({ code: returnedCode, redirectUri, mode: selectedMode });
      });

      server.on("error", reject);

      const timeout = setTimeout(() => {
        server.close();
        reject(new AuthRequiredError("Timed out waiting for the browser sign-in to complete."));
      }, LOOPBACK_TIMEOUT_MS);
      timeout.unref();

      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        redirectUri = `http://127.0.0.1:${address.port}/callback`;
        const oauth2Client = new OAuth2Client({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          redirectUri
        });
        authorizeUrl = oauth2Client.generateAuthUrl({
          access_type: "offline",
          scope: scopes,
          code_challenge_method: CodeChallengeMethod.S256,
          code_challenge: challenge,
          state,
          ...(options.requestIdentityScope ? { nonce } : {}),
          ...(options.forceConsent ? { prompt: "consent" as const } : {})
        });

        const firstUrl = options.setupPageUrl
          ? `${options.setupPageUrl}/connect#port=${address.port}&state=${bootstrapState}`
          : authorizeUrl;
        onAuthorizeUrl(firstUrl);
        // Best effort: the URL is also handed to the caller, which prints it.
        openUrlInBrowser(firstUrl);
      });
    }
  );

  const oauth2Client = new OAuth2Client({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: outcome.redirectUri
  });
  const { tokens } = await oauth2Client.getToken({ code: outcome.code, codeVerifier: verifier });

  if (!tokens.refresh_token) {
    throw new MissingRefreshTokenError();
  }

  // The ID token is only trusted after its nonce, audience, and issuer check
  // out. The gateway independently verifies Google's signature on the same
  // token (see `src/gateway/identity.ts`); this local check exists so a
  // token minted for some *other* consent can never be forwarded from here.
  const idToken = tokens.id_token ?? null;
  if (options.requestIdentityScope && idToken) {
    verifyIdTokenShape(idToken, { nonce, audience: credentials.clientId });
  }

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? "",
    idToken,
    expiryDate: tokens.expiry_date ?? null,
    scopes: (tokens.scope ?? "").split(" ").filter(Boolean),
    mode: outcome.mode
  };
}

/**
 * Checks the claims this process is in a position to check: the nonce it
 * generated, the audience it asked for, and Google as the issuer. The
 * signature is deliberately *not* verified here — it is verified by whoever
 * relies on the token, which is the gateway. This is a "did I get back the
 * token I asked for" check, not an authentication decision.
 */
export function verifyIdTokenShape(idToken: string, expected: { nonce: string; audience: string }): void {
  const segments = idToken.split(".");
  const payloadSegment = segments[1];
  if (segments.length !== 3 || !payloadSegment) {
    throw new AuthRequiredError("Google returned a malformed ID token; aborting for safety.");
  }
  let claims: { nonce?: unknown; aud?: unknown; iss?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as typeof claims;
  } catch {
    throw new AuthRequiredError("Google returned an unreadable ID token; aborting for safety.");
  }
  if (claims.nonce !== expected.nonce) {
    throw new AuthRequiredError("The Google ID token's nonce did not match this sign-in; aborting for safety.");
  }
  if (claims.aud !== expected.audience) {
    throw new AuthRequiredError("The Google ID token was issued for a different app; aborting for safety.");
  }
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") {
    throw new AuthRequiredError("The Google ID token was not issued by Google; aborting for safety.");
  }
}

/** Whether this run should offer the hosted disclosure page for a sign-in. */
export function hostedSetupPageFor(
  client: ResolvedOAuthClient,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  // The hosted page exists to disclose what the *publisher's* service does
  // with mail. A user signing in through their own Cloud project is not using
  // that service, so sending them through the publisher's page would be
  // describing a data transfer that is not going to happen.
  if (client.source !== "publisher") return null;
  return resolveSetupPageUrl(env);
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gmail Agent</title></head><body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.6"><p>${body}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Builds an authenticated client from a stored refresh token for API calls. */
export function oauthClientFromRefreshToken(
  credentials: OAuthClientCredentials,
  refreshToken: string
): OAuth2Client {
  const client = new OAuth2Client({ clientId: credentials.clientId, clientSecret: credentials.clientSecret });
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
