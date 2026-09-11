import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { AuthRequiredError, InvalidConfigError } from "../core/errors.js";
import { openUrlInBrowser } from "../core/open-browser.js";
import { oauthClientFilePath, readStoredOAuthClient } from "./oauth-client-file.js";

/**
 * Restricted Gmail scope plus a narrow Calendar scope limited to events on
 * the user's own calendars. Requested together at initial consent because
 * installed apps do not reliably support incremental authorization.
 *
 * Exactly two scopes, and no identity scopes: everything runs on this
 * computer, so there is no service to prove an identity to. The signed-in
 * address comes from Gmail's own `users.getProfile`, which `gmail.modify`
 * already covers.
 */
export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events.owned"
] as const;

const LOOPBACK_TIMEOUT_MS = 120_000;

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Where the OAuth installed-app client came from: the saved file this tool
 * writes during setup, or environment variables (CI, or someone who prefers
 * to keep it out of a file). Surfaced to `gmail doctor` and the setup UI so
 * "which Cloud project am I actually using" is never a guess.
 */
export type OAuthClientSource = "stored" | "environment";

export interface ResolvedOAuthClient extends OAuthClientCredentials {
  source: OAuthClientSource;
}

/** Message shown whenever no OAuth client is available. Kept in one place so setup, doctor, and login agree. */
export const OAUTH_CLIENT_SETUP_HELP =
  "This computer has no Google OAuth client yet, so it cannot sign in.\n\n" +
  "Everything in this tool runs locally against your own Google project, so you register the app once:\n" +
  "  1. Open https://console.cloud.google.com/ and create a project (any name).\n" +
  "  2. Enable the Gmail API and the Google Calendar API.\n" +
  "  3. On the OAuth consent screen, choose External, add yourself as a test user,\n" +
  "     and add the scopes gmail.modify and calendar.events.owned.\n" +
  "  4. Under Clients, create an OAuth client of type Desktop app.\n" +
  "  5. Run `gmail setup` and paste the client ID and client secret it gives you.\n\n" +
  "See docs/setup.md for the walkthrough with screenshots of each field.";

/**
 * Resolves the installed-app OAuth client: an explicit environment override
 * first, then the client saved on this computer by `gmail setup`.
 *
 * There is no third source. This tool ships no shared client, because a
 * shared client would route every user's consent — and every user's API
 * quota — through whoever registered it. Neither value is confidential (see
 * `oauth-client-file.ts`), so the precedence here is about which Cloud
 * project is in use, not about secrecy.
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
        // Best effort: the URL is also handed to the caller, which prints it.
        openUrlInBrowser(authorizeUrl);
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
