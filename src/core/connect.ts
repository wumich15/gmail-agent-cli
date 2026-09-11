import { AccountsRepository } from "../state/repositories/accounts.js";
import { CREDENTIAL_KEYS } from "../auth/credential-store.js";
import {
  oauthClientFromRefreshToken,
  resolveOAuthClientCredentials,
  runInstalledAppLogin,
  OAUTH_SCOPES
} from "../auth/google-oauth.js";
import { createGmailClient } from "../gmail/client.js";
import { fetchProfile } from "../gmail/scanner.js";
import { accountHashFromEmail } from "./ids.js";
import { loadOrCreateDefaultConfig, saveConfig } from "../config/load.js";
import { DEFAULT_LOCK_WAIT_MS, ProcessLock } from "./lock.js";
import { lockFilePath } from "../config/paths.js";
import { reloadConfig, type CliContext } from "./bootstrap.js";

export interface ConnectResult {
  accountHash: string;
  emailDisplay: string;
  timezone: string;
  grantedScopes: string[];
  /** Scopes Google did not report granting — usually a Workspace admin restriction. */
  missingScopes: string[];
}

export interface ConnectOptions {
  /** Called with the Google consent URL, for a terminal fallback or a link in the UI. */
  onAuthorizeUrl?: (url: string) => void;
  /**
   * Confirms or replaces the detected IANA timezone. Injected rather than
   * prompted for here so this whole operation stays free of any particular
   * interface: the CLI passes a prompt, the browser UI passes the value
   * the page already read from the viewer's own browser.
   */
  resolveTimezone?: (detected: string) => Promise<string> | string;
}

/**
 * The complete Google connect operation, with no prompts and no rendering:
 * browser OAuth, profile lookup, single-account enforcement, credential
 * storage, account row, and config write.
 *
 * Connecting deliberately does *not* touch the mailbox. Finishing sign-in
 * must never be what starts a cleanup run — that stays a separate,
 * explicit action, which is exactly why this returns instead of chaining
 * into work.
 */
export async function connectGoogleAccount(ctx: CliContext, options: ConnectOptions = {}): Promise<ConnectResult> {
  const credentials = resolveOAuthClientCredentials();
  const result = await runInstalledAppLogin(credentials, (url) => options.onAuthorizeUrl?.(url));

  const oauthClient = oauthClientFromRefreshToken(credentials, result.refreshToken);
  const profile = await fetchProfile(createGmailClient(oauthClient));
  const accountHash = accountHashFromEmail(profile.emailAddress);

  // Held from the moment an account is identified: everything below
  // mutates the credential store and durable account state, which
  // CLAUDE.md requires the per-account lock for.
  const lock = new ProcessLock(lockFilePath(accountHash));
  lock.acquire({ waitMs: DEFAULT_LOCK_WAIT_MS });
  try {
    await ctx.credentialStore.setSecret(CREDENTIAL_KEYS.oauthRefreshToken(accountHash), result.refreshToken);

    // v1 supports exactly one signed-in account. Enforce that explicitly
    // rather than letting a fresh sign-in as a different Google account
    // leave a stale row (and its stored credential) behind — there would
    // be no principled way to know which of two rows is "current".
    const accountsRepo = new AccountsRepository(ctx.db);
    const staleRows = ctx.db.prepare("SELECT account_hash FROM accounts WHERE account_hash != ?").all(accountHash) as {
      account_hash: string;
    }[];
    for (const { account_hash: staleHash } of staleRows) {
      await ctx.credentialStore.deleteSecret(CREDENTIAL_KEYS.oauthRefreshToken(staleHash));
    }
    ctx.db.prepare("DELETE FROM accounts WHERE account_hash != ?").run(accountHash);

    const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezone = (await options.resolveTimezone?.(detectedTimezone)) || detectedTimezone;

    const now = ctx.clock.nowIso();
    accountsRepo.upsert({
      accountHash,
      emailDisplay: profile.emailAddress,
      timezone,
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: now,
      updatedAt: now
    });

    const config = loadOrCreateDefaultConfig(timezone);
    saveConfig({ ...config, timezone });
    // The process cached its config at startup, before any of this
    // existed. Refresh it so the rest of this run sees what was written
    // rather than a pre-sign-in snapshot.
    reloadConfig(ctx);

    return {
      accountHash,
      emailDisplay: profile.emailAddress,
      timezone,
      grantedScopes: result.scopes,
      missingScopes: OAUTH_SCOPES.filter((scope) => !result.scopes.includes(scope))
    };
  } finally {
    lock.release();
  }
}
