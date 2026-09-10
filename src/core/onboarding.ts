import { AccountsRepository } from "../state/repositories/accounts.js";
import { CREDENTIAL_KEYS } from "../auth/credential-store.js";
import {
  isInvalidGrantError,
  oauthClientFromRefreshToken,
  resolveOAuthClientCredentials,
  OAUTH_SCOPES,
  type OAuthClientSource
} from "../auth/google-oauth.js";
import { AI_ACCESS_OPTIONS, checkLocalRuntime, currentAiAccess, type AiAccessId, type AiAccessOption } from "./ai-access.js";
import { resolveAiCredentials } from "../ai/resolve-classifier.js";
import type { CliContext } from "./bootstrap.js";

/**
 * Prompt-independent onboarding and status operations.
 *
 * Everything here is a typed function over the existing core — no prompts,
 * no terminal rendering, no shell. That is what lets the browser front-end
 * and the CLI drive the same setup without the front-end scraping an
 * interactive terminal or executing command text, which it must never do.
 */

export interface ConnectionStatus {
  connected: boolean;
  emailDisplay: string | null;
  timezone: string | null;
  accountHash: string | null;
  automationEnabled: boolean;
  /** Whether the stored refresh token is present at all (not whether Google still honors it). */
  credentialStored: boolean;
  /** The scopes this app requests, with why, for the permissions explanation. */
  scopes: ReadonlyArray<{ scope: string; why: string }>;
  /** "none" means this build cannot sign anyone in yet; see `auth/publisher-client.ts`. */
  oauthClientSource: OAuthClientSource | "none";
}

const SCOPE_EXPLANATIONS: Record<string, string> = {
  "https://www.googleapis.com/auth/gmail.modify":
    "Read your mail's headers and text, move messages to Trash, archive read mail, and add stars and labels. It cannot permanently delete anything.",
  "https://www.googleapis.com/auth/calendar.events.owned":
    "Create and update only the events this app itself created on your own calendar. It never adds guests, sends invitations, or touches events it did not create."
};

export function requestedScopes(): ReadonlyArray<{ scope: string; why: string }> {
  return OAUTH_SCOPES.map((scope) => ({ scope, why: SCOPE_EXPLANATIONS[scope] ?? "" }));
}

export function getConnectionStatus(ctx: CliContext): Promise<ConnectionStatus> {
  return (async () => {
    let oauthClientSource: OAuthClientSource | "none";
    try {
      oauthClientSource = resolveOAuthClientCredentials().source;
    } catch {
      oauthClientSource = "none";
    }

    const rows = ctx.db.prepare("SELECT account_hash FROM accounts ORDER BY updated_at DESC LIMIT 1").all() as {
      account_hash: string;
    }[];
    const row = rows[0];
    const account = row ? new AccountsRepository(ctx.db).get(row.account_hash) : null;
    if (!account) {
      return {
        connected: false,
        emailDisplay: null,
        timezone: ctx.config?.timezone ?? null,
        accountHash: null,
        automationEnabled: false,
        credentialStored: false,
        scopes: requestedScopes(),
        oauthClientSource
      };
    }
    const credentialStored =
      (await ctx.credentialStore.getSecret(CREDENTIAL_KEYS.oauthRefreshToken(account.accountHash))) !== null;
    return {
      connected: credentialStored,
      emailDisplay: account.emailDisplay,
      timezone: account.timezone,
      accountHash: account.accountHash,
      automationEnabled: account.automationEnabled,
      credentialStored,
      scopes: requestedScopes(),
      oauthClientSource
    };
  })();
}

export interface AiStatus {
  access: AiAccessId;
  /** Whether a run right now would actually classify with a model. */
  ready: boolean;
  /** One sentence about the current state, safe to show verbatim. Never contains a key. */
  detail: string;
  model: string | null;
  options: readonly AiAccessOption[];
}

/**
 * Reports whether AI would actually work right now, not merely what is
 * configured — a chosen local runtime that is not running, or a key that
 * was removed from the keychain, both have to read as "not ready" here,
 * because that is the difference between classified mail and a run that
 * quietly leaves everything for Review.
 */
export async function getAiStatus(ctx: CliContext, accountHash: string | null): Promise<AiStatus> {
  const access = currentAiAccess(ctx.config);
  const base = { access, options: AI_ACCESS_OPTIONS };
  if (access === "off") {
    return { ...base, ready: false, model: null, detail: "AI is off. Mail is handled by rules only." };
  }
  const credentials = await resolveAiCredentials({
    accountHash: accountHash ?? "",
    credentialStore: ctx.credentialStore,
    config: ctx.config
  });
  if (!credentials) {
    return {
      ...base,
      ready: false,
      model: null,
      detail: "AI is selected but no usable API key was found, so runs fall back to rules only."
    };
  }
  if (credentials.provider === "ollama") {
    const runtime = await checkLocalRuntime(credentials.baseURL ?? undefined);
    if (!runtime.reachable) {
      return { ...base, ready: false, model: credentials.model, detail: runtime.problem ?? "The local model runtime is not reachable." };
    }
    const pulled = runtime.models.some((name) => name === credentials.model || name.startsWith(`${credentials.model}:`));
    return {
      ...base,
      ready: pulled,
      model: credentials.model,
      detail: pulled
        ? `Local model "${credentials.model}" is running on this computer. No mail leaves the machine.`
        : `The local runtime is running but has no model named "${credentials.model}". Run: ollama pull ${credentials.model}`
    };
  }
  return {
    ...base,
    ready: true,
    model: credentials.model,
    detail:
      credentials.provider === "openai-compatible"
        ? `Using your own API key against ${credentials.baseURL} (model: ${credentials.model}).`
        : `Using the OpenAI API with your own key (model: ${credentials.model}).`
  };
}

export interface DisconnectResult {
  revoked: boolean;
  /** Present when Google could not be told to drop the grant; local credentials are erased regardless. */
  revokeProblem?: string;
  historyRemoved: boolean;
}

/**
 * Removes this machine's ability to act on the account: revokes the grant
 * with Google when possible, then erases the stored refresh token whether
 * or not the revoke succeeded — an unusable-but-present token is worse
 * than none, since it makes every later run fail confusingly.
 *
 * Local non-secret history (runs, rules, cached projections) is a separate
 * decision the caller must make explicitly; disconnecting is not the same
 * as asking to forget everything that ever happened.
 */
export async function disconnectAccount(
  ctx: CliContext,
  accountHash: string,
  options: { removeHistory: boolean }
): Promise<DisconnectResult> {
  const secretKey = CREDENTIAL_KEYS.oauthRefreshToken(accountHash);
  const refreshToken = await ctx.credentialStore.getSecret(secretKey);

  let revoked = false;
  let revokeProblem: string | undefined;
  if (refreshToken) {
    try {
      const credentials = resolveOAuthClientCredentials();
      await oauthClientFromRefreshToken(credentials, refreshToken).revokeToken(refreshToken);
      revoked = true;
    } catch (error) {
      // An already-revoked grant is the expected case here, not a failure
      // worth alarming the user about.
      revoked = isInvalidGrantError(error);
      if (!revoked) {
        revokeProblem = error instanceof Error ? error.message : String(error);
      }
    }
  }

  await ctx.credentialStore.deleteSecret(secretKey);
  if (options.removeHistory) {
    ctx.db.prepare("DELETE FROM accounts WHERE account_hash = ?").run(accountHash);
  }
  return { revoked, historyRemoved: options.removeHistory, ...(revokeProblem ? { revokeProblem } : {}) };
}
