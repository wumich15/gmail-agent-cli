import { AccountsRepository } from "../state/repositories/accounts.js";
import { CREDENTIAL_KEYS } from "../auth/credential-store.js";
import {
  hostedSetupPageFor,
  MissingRefreshTokenError,
  oauthClientFromRefreshToken,
  resolveOAuthClientCredentials,
  runInstalledAppLogin,
  OAUTH_SCOPES,
  type ConnectMode,
  type LoginResult
} from "../auth/google-oauth.js";
import { bootstrapHostedSession } from "../auth/hosted-session.js";
import { HOSTED_AI_POLICY_VERSION, resolveHostedAiService } from "../auth/publisher-client.js";
import { applyAiAccessChoice } from "./ai-access.js";
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
  /**
   * What the user chose on the hosted disclosure page, or null when there was
   * no such page in this flow (a source build, or a user signing in through
   * their own Cloud project). Null means the caller still has to ask how this
   * install should get AI.
   */
  aiMode: ConnectMode | null;
  /**
   * Set when the hosted-AI choice could not be completed — the service was
   * unreachable, or it declined the session. Gmail is connected either way;
   * this install simply stays on rules only until setup is run again. Never a
   * reason to fail the whole sign-in: the user's Google consent is done, and
   * throwing it away because a separate service was down would be worse.
   */
  hostedAiProblem?: string;
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
  const setupPageUrl = hostedSetupPageFor(credentials);
  const hostedService = resolveHostedAiService();
  // `openid` is requested only when there is a service for the resulting ID
  // token to authenticate to. A fully local install asks for two scopes, as
  // it always has.
  const requestIdentityScope = setupPageUrl !== null && hostedService !== null;

  const login = async (forceConsent: boolean): Promise<LoginResult> =>
    runInstalledAppLogin(credentials, (url) => options.onAuthorizeUrl?.(url), {
      requestIdentityScope,
      setupPageUrl,
      forceConsent
    });

  let result: LoginResult;
  try {
    result = await login(false);
  } catch (error) {
    // Google returns no refresh token when it considers the app already
    // authorized. Re-asking with an explicit consent prompt is the documented
    // recovery — once. A second failure means something another consent
    // screen will not fix, so it propagates.
    if (!(error instanceof MissingRefreshTokenError)) throw error;
    result = await login(true);
  }

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

    // The AI choice the user made on the disclosure page, applied here so it
    // is recorded in the same operation as the sign-in it was part of. A
    // failure to reach the service leaves this install on rules only and is
    // reported, never retried silently and never fatal.
    let hostedAiProblem: string | undefined;
    if (result.mode === "hosted-ai" && hostedService && result.idToken) {
      try {
        await bootstrapHostedSession({
          service: hostedService,
          googleIdToken: result.idToken,
          policyVersion: HOSTED_AI_POLICY_VERSION,
          accountHash,
          credentialStore: ctx.credentialStore
        });
        await applyAiAccessChoice({
          config: { ...config, timezone },
          choice: "hosted",
          accountHash,
          credentialStore: ctx.credentialStore,
          consentedAt: now
        });
      } catch (error) {
        hostedAiProblem = error instanceof Error ? error.message : String(error);
      }
    } else if (result.mode === "hosted-ai") {
      hostedAiProblem =
        "Google did not return the identity token the AI service needs, so hosted AI was not enabled.";
    } else if (result.mode === "rules-only") {
      // An explicit "connect without hosted AI" must actually leave AI off,
      // not inherit whatever a previous install happened to configure.
      await applyAiAccessChoice({
        config: { ...config, timezone },
        choice: "off",
        accountHash,
        credentialStore: ctx.credentialStore
      });
    }

    // The process cached its config at startup, before any of this
    // existed. Refresh it so the rest of this run sees what was written
    // rather than a pre-sign-in snapshot.
    reloadConfig(ctx);

    return {
      accountHash,
      emailDisplay: profile.emailAddress,
      timezone,
      grantedScopes: result.scopes,
      missingScopes: OAUTH_SCOPES.filter((scope) => !result.scopes.includes(scope)),
      aiMode: result.mode,
      ...(hostedAiProblem ? { hostedAiProblem } : {})
    };
  } finally {
    lock.release();
  }
}
