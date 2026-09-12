import { CREDENTIAL_KEYS, type CredentialStore } from "./credential-store.js";
import { AuthRequiredError } from "../core/errors.js";
import type { HostedAiService } from "./publisher-client.js";

/**
 * The CLI's half of the hosted AI session.
 *
 * Google's consent produces a short-lived ID token. That token is presented
 * exactly once, to the gateway's `/v1/session/bootstrap`, which verifies it
 * against the publisher's own Desktop client audience, records a pseudonymous
 * consent receipt, and returns a one-time Firebase custom token. The CLI
 * exchanges that for a Firebase ID token plus a Firebase refresh token, and
 * only the refresh token is stored — in the OS credential store, under a key
 * distinct from Google's.
 *
 * Why not just keep re-presenting Google's ID token: it expires in an hour
 * and there is no offline way to mint another without spending the Gmail
 * refresh token, which must never leave this computer. A separate Firebase
 * session also means the publisher can revoke a user's access to the AI
 * service without touching their Gmail authorization, and the user can drop
 * the AI service without signing out of Gmail.
 *
 * Nothing in this file ever sends a Gmail token, a message, or an email
 * address to the gateway.
 */

const IDENTITY_TOOLKIT_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken";
const SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";

const REQUEST_TIMEOUT_MS = 15_000;
/** Refresh a little early so a long run never trips over an expiry mid-flight. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

export class HostedSessionError extends AuthRequiredError {
  constructor(
    message: string,
    /** True when re-running setup is the fix, rather than retrying later. */
    readonly needsReconsent: boolean
  ) {
    super(message);
    this.name = "HostedSessionError";
  }
}

interface FirebaseTokenPair {
  idToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

async function postJson(url: string, body: unknown, init: { bearer?: string } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error"
    });
  } catch (error) {
    throw new HostedSessionError(
      `Could not reach the AI service: ${error instanceof Error ? error.message : String(error)}`,
      false
    );
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    // Only the service's own short `error` string is surfaced. A raw provider
    // body can carry tokens or request identifiers, which must not reach the
    // terminal or a log line.
    const detail =
      typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `HTTP ${response.status}`;
    throw new HostedSessionError(
      `The AI service rejected the sign-in (${detail}).`,
      response.status === 401 || response.status === 403
    );
  }
  return parsed;
}

async function exchangeCustomToken(service: HostedAiService, customToken: string): Promise<FirebaseTokenPair> {
  const result = (await postJson(`${IDENTITY_TOOLKIT_URL}?key=${encodeURIComponent(service.firebaseApiKey)}`, {
    token: customToken,
    returnSecureToken: true
  })) as { idToken?: string; refreshToken?: string; expiresIn?: string };
  if (!result?.idToken || !result.refreshToken) {
    throw new HostedSessionError("The AI service returned an unusable session token.", true);
  }
  return {
    idToken: result.idToken,
    refreshToken: result.refreshToken,
    expiresAtMs: Date.now() + Number(result.expiresIn ?? 3600) * 1000
  };
}

async function refreshIdToken(service: HostedAiService, refreshToken: string): Promise<FirebaseTokenPair> {
  let response: Response;
  try {
    response = await fetch(`${SECURE_TOKEN_URL}?key=${encodeURIComponent(service.firebaseApiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error"
    });
  } catch (error) {
    throw new HostedSessionError(
      `Could not reach the AI service: ${error instanceof Error ? error.message : String(error)}`,
      false
    );
  }
  if (!response.ok) {
    // A rejected refresh token is terminal: the session was revoked, the user
    // was blocked, or the token was rotated out. Retrying it can only keep
    // failing, so this asks for setup rather than backing off.
    throw new HostedSessionError(
      "The hosted AI session has expired or been revoked. Run `gmail setup` to reconnect it.",
      response.status === 400 || response.status === 401 || response.status === 403
    );
  }
  const result = (await response.json()) as { id_token?: string; refresh_token?: string; expires_in?: string };
  if (!result?.id_token || !result.refresh_token) {
    throw new HostedSessionError("The AI service returned an unusable session token.", true);
  }
  return {
    idToken: result.id_token,
    refreshToken: result.refresh_token,
    expiresAtMs: Date.now() + Number(result.expires_in ?? 3600) * 1000
  };
}

export interface BootstrapHostedSessionInput {
  service: HostedAiService;
  /** Google's OIDC ID token from the sign-in that just completed. Used once, never stored. */
  googleIdToken: string;
  /** The exact disclosure version the user accepted, recorded with the receipt. */
  policyVersion: string;
  accountHash: string;
  credentialStore: CredentialStore;
}

export interface BootstrapHostedSessionResult {
  /** Whatever allowance the service reports, for the terminal to echo back. */
  allowance: string | null;
}

/**
 * Establishes the hosted session after a successful Google consent, storing
 * only the Firebase refresh token. Called once, at setup, and again only when
 * the user re-enables hosted AI.
 */
export async function bootstrapHostedSession(
  input: BootstrapHostedSessionInput
): Promise<BootstrapHostedSessionResult> {
  const bootstrap = (await postJson(`${input.service.baseUrl}/v1/session/bootstrap`, {
    googleIdToken: input.googleIdToken,
    policyVersion: input.policyVersion,
    hostedAiAccepted: true
  })) as { customToken?: string; allowance?: string };
  if (!bootstrap?.customToken) {
    throw new HostedSessionError("The AI service did not return a usable session.", true);
  }
  const tokens = await exchangeCustomToken(input.service, bootstrap.customToken);
  await input.credentialStore.setSecret(
    CREDENTIAL_KEYS.hostedSessionRefreshToken(input.accountHash),
    tokens.refreshToken
  );
  return { allowance: bootstrap.allowance ?? null };
}

/**
 * A live hosted session: hands out short-lived Firebase ID tokens, refreshing
 * from the stored refresh token when the current one is close to expiring.
 *
 * One instance per command. The ID token is held in memory only, exactly like
 * Google's access token.
 */
export class HostedSession {
  private current: FirebaseTokenPair | null = null;
  private inFlight: Promise<FirebaseTokenPair> | null = null;

  constructor(
    private readonly service: HostedAiService,
    private readonly accountHash: string,
    private readonly credentialStore: CredentialStore
  ) {}

  /** Returns a token valid for at least the safety margin, refreshing if needed. */
  async idToken(): Promise<string> {
    if (this.current && this.current.expiresAtMs - EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
      return this.current.idToken;
    }
    // A run classifies many messages concurrently; without this, every worker
    // that happened to find the token stale would start its own refresh and
    // the last one to finish would win, rotating the stored refresh token
    // several times for no reason.
    this.inFlight ??= this.renew().finally(() => {
      this.inFlight = null;
    });
    const renewed = await this.inFlight;
    return renewed.idToken;
  }

  private async renew(): Promise<FirebaseTokenPair> {
    const stored = await this.credentialStore.getSecret(
      CREDENTIAL_KEYS.hostedSessionRefreshToken(this.accountHash)
    );
    if (!stored) {
      throw new HostedSessionError("This computer has no hosted AI session. Run `gmail setup` to connect one.", true);
    }
    const tokens = await refreshIdToken(this.service, stored);
    // Firebase may hand back a rotated refresh token; persisting it keeps the
    // next command from starting with one the service has already retired.
    if (tokens.refreshToken !== stored) {
      await this.credentialStore.setSecret(
        CREDENTIAL_KEYS.hostedSessionRefreshToken(this.accountHash),
        tokens.refreshToken
      );
    }
    this.current = tokens;
    return tokens;
  }
}

/** Whether this computer has a hosted session at all, without contacting anything. */
export async function hostedSessionStored(
  accountHash: string,
  credentialStore: CredentialStore
): Promise<boolean> {
  return (await credentialStore.getSecret(CREDENTIAL_KEYS.hostedSessionRefreshToken(accountHash))) !== null;
}

/**
 * Drops this computer's hosted session and asks the service to revoke the
 * entitlement behind it. The local secret is erased either way: an
 * unusable-but-present token is worse than none, since it turns every later
 * run into a confusing failure.
 */
export async function disconnectHostedSession(input: {
  service: HostedAiService | null;
  accountHash: string;
  credentialStore: CredentialStore;
}): Promise<{ revoked: boolean; problem?: string }> {
  const key = CREDENTIAL_KEYS.hostedSessionRefreshToken(input.accountHash);
  const stored = await input.credentialStore.getSecret(key);
  let revoked = false;
  let problem: string | undefined;
  if (stored && input.service) {
    try {
      const session = new HostedSession(input.service, input.accountHash, input.credentialStore);
      const idToken = await session.idToken();
      await postJson(`${input.service.baseUrl}/v1/session/revoke`, {}, { bearer: idToken });
      revoked = true;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
  }
  await input.credentialStore.deleteSecret(key);
  return { revoked, ...(problem ? { problem } : {}) };
}
