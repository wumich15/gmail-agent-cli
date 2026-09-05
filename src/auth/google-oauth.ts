import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { AuthRequiredError, InvalidConfigError } from "../core/errors.js";

/**
 * Restricted Gmail scope plus a narrow Calendar scope limited to events on
 * the user's own calendars. Requested together at initial consent because
 * installed apps do not reliably support incremental authorization.
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
 * Development builds authenticate with a user-supplied Desktop OAuth
 * client (Google Cloud Console > Credentials > OAuth client ID > Desktop
 * app). A public release must instead ship a publisher-managed, verified
 * OAuth project; that client is not read from the environment.
 */
export function loadDevOAuthClientCredentials(
  env: NodeJS.ProcessEnv = process.env
): OAuthClientCredentials {
  const clientId = env["GMAIL_AGENT_OAUTH_CLIENT_ID"];
  const clientSecret = env["GMAIL_AGENT_OAUTH_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new InvalidConfigError(
      "No OAuth client is configured. Development builds need GMAIL_AGENT_OAUTH_CLIENT_ID and " +
        "GMAIL_AGENT_OAUTH_CLIENT_SECRET for a Desktop-type OAuth client from the Google Cloud " +
        "Console. A public release would ship a verified, publisher-managed client instead."
    );
  }
  return { clientId, clientSecret };
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
        const address = server.address() as AddressInfo;
        resolve({ code: returnedCode, redirectUri: `http://127.0.0.1:${address.port}/callback` });
      });

      server.on("error", reject);

      const timeout = setTimeout(() => {
        server.close();
        reject(new AuthRequiredError("Timed out waiting for the browser sign-in to complete."));
      }, LOOPBACK_TIMEOUT_MS);
      timeout.unref();

      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        const redirectUri = `http://127.0.0.1:${address.port}/callback`;
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
      "Google did not return a refresh token. Re-run `gmail auth login`; if this keeps " +
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
