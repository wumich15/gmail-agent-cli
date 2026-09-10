import { reloadConfig, type CliContext } from "../core/bootstrap.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { CREDENTIAL_KEYS } from "../auth/credential-store.js";
import { isInvalidGrantError, resolveOAuthClientCredentials, oauthClientFromRefreshToken } from "../auth/google-oauth.js";
import { createGmailClient, type GmailClient } from "../gmail/client.js";
import { createCalendarClient, type CalendarClient } from "../calendar/client.js";
import { AuthRequiredError } from "../core/errors.js";
import { authLogin } from "./auth.js";
import type { AccountRecord } from "../core/models.js";
import type { OAuth2Client } from "google-auth-library";

export interface ResolvedAccount {
  account: AccountRecord;
  oauthClient: OAuth2Client;
  gmailClient: GmailClient;
  calendarClient: CalendarClient;
}

/** v1 supports one signed-in account; resolves it and builds authenticated API clients. */
export async function resolveAccount(ctx: CliContext): Promise<ResolvedAccount> {
  // v1 supports exactly one signed-in account, and authLogin removes any
  // other account row on a fresh sign-in — but ORDER BY here is defense
  // in depth against that invariant ever being violated (e.g. a crash
  // mid-login): without it, a bare `LIMIT 1` has no defined ordering and
  // could resolve to a stale row instead of the one the user most
  // recently actually authenticated as.
  const rows = ctx.db.prepare("SELECT account_hash FROM accounts ORDER BY updated_at DESC LIMIT 1").all() as {
    account_hash: string;
  }[];
  const row = rows[0];
  if (!row) {
    throw new AuthRequiredError();
  }
  const account = new AccountsRepository(ctx.db).get(row.account_hash);
  if (!account) {
    throw new AuthRequiredError();
  }
  const refreshToken = await ctx.credentialStore.getSecret(CREDENTIAL_KEYS.oauthRefreshToken(account.accountHash));
  if (!refreshToken) {
    throw new AuthRequiredError();
  }
  const credentials = resolveOAuthClientCredentials();
  const oauthClient = oauthClientFromRefreshToken(credentials, refreshToken);
  return {
    account,
    oauthClient,
    gmailClient: createGmailClient(oauthClient),
    calendarClient: createCalendarClient(oauthClient)
  };
}

/**
 * Exchanges the stored refresh token for an access token up front, so a
 * credential Google no longer honors is discovered here — at one known
 * point, before any mailbox work begins — instead of surfacing later as an
 * unexplained Gmail failure partway through a run. The token this obtains
 * is cached on the client, so the first real API call does not pay for it
 * twice.
 *
 * On `invalid_grant` (the user revoked access, the password changed, or a
 * Testing-mode grant hit its seven-day expiry) the unusable token is
 * erased, because retrying it can only keep failing.
 */
async function assertCredentialsUsable(ctx: CliContext, resolved: ResolvedAccount): Promise<void> {
  try {
    await resolved.oauthClient.getAccessToken();
  } catch (error) {
    if (!isInvalidGrantError(error)) {
      throw error;
    }
    await ctx.credentialStore.deleteSecret(CREDENTIAL_KEYS.oauthRefreshToken(resolved.account.accountHash));
    throw new AuthRequiredError(
      "Your Google sign-in is no longer valid — it was revoked, expired, or the account password changed. " +
        "Reconnecting requires signing in again."
    );
  }
}

/**
 * Same as `resolveAccount`, but signs in inline (in the system browser) the
 * first time there's no account yet, rather than requiring a separate
 * `gmail auth login` first — this is what lets `gmail` and `gmail cache`
 * both work as one-shot commands with no prerequisite setup step.
 *
 * A revoked or expired grant takes the same path: the dead credential is
 * erased and consent is requested again, exactly once. There is no retry
 * loop — if the fresh sign-in also fails, the original error is raised.
 */
export async function resolveAccountSigningInIfNeeded(ctx: CliContext): Promise<ResolvedAccount> {
  try {
    const resolved = await resolveAccount(ctx);
    await assertCredentialsUsable(ctx, resolved);
    return resolved;
  } catch (error) {
    if (!(error instanceof AuthRequiredError)) {
      throw error;
    }
    const loginExitCode = await authLogin();
    if (loginExitCode !== 0) {
      throw error;
    }
    // Sign-in writes config.json (timezone, and the AI access choice made
    // during onboarding). Without this, the rest of this same process
    // would keep using the config snapshot taken before any of it existed.
    reloadConfig(ctx);
    return resolveAccount(ctx);
  }
}
