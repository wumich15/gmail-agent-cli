import type { CliContext } from "../core/bootstrap.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { CREDENTIAL_KEYS } from "../auth/credential-store.js";
import { loadDevOAuthClientCredentials, oauthClientFromRefreshToken } from "../auth/google-oauth.js";
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
  const rows = ctx.db.prepare("SELECT account_hash FROM accounts LIMIT 1").all() as {
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
  const credentials = loadDevOAuthClientCredentials();
  const oauthClient = oauthClientFromRefreshToken(credentials, refreshToken);
  return {
    account,
    oauthClient,
    gmailClient: createGmailClient(oauthClient),
    calendarClient: createCalendarClient(oauthClient)
  };
}

/**
 * Same as `resolveAccount`, but signs in inline (in the system browser) the
 * first time there's no account yet, rather than requiring a separate
 * `gmail auth login` first — this is what lets `gmail` and `gmail cache`
 * both work as one-shot commands with no prerequisite setup step.
 */
export async function resolveAccountSigningInIfNeeded(ctx: CliContext): Promise<ResolvedAccount> {
  try {
    return await resolveAccount(ctx);
  } catch (error) {
    if (!(error instanceof AuthRequiredError)) {
      throw error;
    }
    const loginExitCode = await authLogin();
    if (loginExitCode !== 0) {
      throw error;
    }
    return resolveAccount(ctx);
  }
}
