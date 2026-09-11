import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { AuthRequiredError, InvalidConfigError } from "../core/errors.js";
import {
  PUBLISHER_OAUTH_CLIENT_ID,
  PUBLISHER_OAUTH_CLIENT_SECRET,
  publisherOAuthClientConfigured
} from "./publisher-client.js";

/**
 * Restricted Gmail scope plus a narrow Calendar scope limited to events on
 * the user's own calendars. Requested together at initial consent because
 * installed apps do not reliably support incremental authorization.
 */
export const OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events.owned"
] as const;

const LOOPBACK_TIMEOUT_MS = 120_000;

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Where the OAuth installed-app client came from. Surfaced to the user
 * (and to `gmail doctor`/the setup UI) because the two have very different
 * onboarding stories: a publisher client means "just press Connect", while
 * a development client means the operator supplied their own Cloud project.
 */
export type OAuthClientSource = "publisher" | "environment";

export interface ResolvedOAuthClient extends OAuthClientCredentials {
  source: OAuthClientSource;
}

/**
 * Resolves the installed-app OAuth client, preferring an explicit
 * environment override (development, or an operator running against their
 * own Cloud project) over the publisher client shipped with a release
 * build. Neither is confidential — see `publisher-client.ts` — so the
 * precedence here is purely about which project the consent screen and
 * quota belong to, not about secrecy.
 *
 * Throws only when this build has no publisher client *and* no environment
 * override, which is the state of the source tree today.
 */
export function resolveOAuthClientCredentials(env: NodeJS.ProcessEnv = process.env): ResolvedOAuthClient {
  const clientId = env["GMAIL_AGENT_OAUTH_CLIENT_ID"];
  const clientSecret = env["GMAIL_AGENT_OAUTH_CLIENT_SECRET"];
  if (clientId && clientSecret) {
    return { clientId, clientSecret, source: "environment" };
  }
  if (publisherOAuthClientConfigured()) {
    return {
      clientId: PUBLISHER_OAUTH_CLIENT_ID,
      clientSecret: PUBLISHER_OAUTH_CLIENT_SECRET,
      source: "publisher"
    };
  }
  throw new InvalidConfigError(
    "This build has no Google OAuth client, so it cannot sign in yet. A release build ships a " +
      "verified publisher client and needs nothing from you. To run this development build, create " +
      "a Desktop-type OAuth client in the Google Cloud Console (with the Gmail and Calendar APIs " +
      "enabled) and set GMAIL_AGENT_OAUTH_CLIENT_ID and GMAIL_AGENT_OAUTH_CLIENT_SECRET."
  );
}

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

function openInBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin" ? `open "${url}"` : platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {
    // Best-effort only; the URL is also printed to the terminal.
  });
}

export interface LoginResult {
  refreshToken: string;
  accessToken: string;
  expiryDate: number | null;
  scopes: string[];
}

/**
 * Runs the OAuth 2.0 installed-app flow: PKCE S256, random state, and a
 * loopback listener bound only to 127.0.0.1 on an OS-assigned port. Closes
 * the listener on success, error, or timeout, and validates state before
 * exchanging the authorization code.
 */
export async function runInstalledAppLogin(
  credentials: OAuthClientCredentials,
  onAuthorizeUrl: (url: string) => void
): Promise<LoginResult> {
  const { verifier, challenge } = generatePkcePair();
  const state = base64Url(randomBytes(16));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
    (resolve, reject) => {
      // Captured once the server starts listening. Reading it again from
      // server.address() after server.close() (called by finish() below)
      // returns null — close() clears the listening address immediately,
      // before the 'close' event even fires — so the callback handler
      // reuses this instead of re-deriving it post-close.
      let redirectUri = "";

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const returnedCode = url.searchParams.get("code");

        const finish = (body: string) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
          server.close();
        };

        if (error) {
          finish(`<html><body>Authorization failed: ${escapeHtml(error)}. You can close this tab.</body></html>`);
          reject(new AuthRequiredError(`Google returned an OAuth error: ${error}`));
          return;
        }
        if (returnedState !== state || !returnedCode) {
          finish("<html><body>Invalid authorization response. You can close this tab.</body></html>");
          reject(new AuthRequiredError("OAuth state mismatch or missing code; aborting for safety."));
          return;
        }
        finish("<html><body>Signed in. You can close this tab and return to the terminal.</body></html>");
        resolve({ code: returnedCode, redirectUri });
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
        const authorizeUrl = oauth2Client.generateAuthUrl({
          access_type: "offline",
          scope: [...OAUTH_SCOPES],
          code_challenge_method: CodeChallengeMethod.S256,
          code_challenge: challenge,
          state,
          prompt: "consent"
        });
        onAuthorizeUrl(authorizeUrl);
        openInBrowser(authorizeUrl);
      });
    }
  );

  const oauth2Client = new OAuth2Client({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri
  });
  const { tokens } = await oauth2Client.getToken({ code, codeVerifier: verifier });

  if (!tokens.refresh_token) {
    throw new AuthRequiredError(
      "Google did not return a refresh token. Re-run `gmail` to sign in again; if this keeps " +
        "happening, revoke the app's access at https://myaccount.google.com/permissions and retry."
    );
  }

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? "",
    expiryDate: tokens.expiry_date ?? null,
    scopes: (tokens.scope ?? "").split(" ").filter(Boolean)
  };
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

/**
 * Gets a short-lived Google ID token for authenticating this user to the
 * publisher AI gateway. The Gmail access token is never sent to that
 * service. Google can return a new ID token on refresh when `openid` was
 * granted, so nothing beyond the existing refresh token is persisted.
 */
export async function googleIdTokenFromRefreshToken(
  credentials: OAuthClientCredentials,
  refreshToken: string
): Promise<string> {
  const client = oauthClientFromRefreshToken(credentials, refreshToken);
  await client.getAccessToken();
  const idToken = client.credentials.id_token;
  if (!idToken) {
    throw new AuthRequiredError(
      "Google did not return an identity token for the included AI service. Reconnect Gmail to grant the updated sign-in permissions."
    );
  }
  return idToken;
}
