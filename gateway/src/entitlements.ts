import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { IdentityError } from "./identity.js";
import type { GatewayConfig } from "./config.js";

/**
 * Consent receipts and entitlements.
 *
 * A receipt is the record that a specific person affirmatively accepted a
 * specific version of the hosted-AI disclosure at a specific moment. The
 * gateway refuses message text from anyone without a current, non-revoked
 * one, which is what makes the disclosure a gate rather than a notice.
 *
 * What is stored, and nothing else: the pseudonymous user ID as the document
 * key, the accepted policy version, timestamps, and a status. No email
 * address, no Google `sub`, no prompt, no response, no message content.
 */

export const USERS_COLLECTION = "users";

export type EntitlementStatus = "active" | "revoked" | "blocked";

export interface Entitlement {
  userId: string;
  status: EntitlementStatus;
  policyVersion: string;
  consentedAt: string;
  updatedAt: string;
}

interface EntitlementDocument {
  status?: EntitlementStatus;
  policyVersion?: string;
  consentedAt?: string;
  updatedAt?: string;
}

export class EntitlementError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

/**
 * Records an affirmative acceptance of the current disclosure.
 *
 * A blocked user cannot re-consent their way back in: block is an operator
 * decision, and re-running setup must not be a way around it.
 */
export async function recordConsent(input: {
  userId: string;
  policyVersion: string;
  config: GatewayConfig;
  nowIso: string;
}): Promise<Entitlement> {
  if (input.policyVersion !== input.config.policyVersion) {
    throw new EntitlementError(
      "This version of the CLI accepted an outdated data disclosure. Upgrade it and run `gmail setup` again.",
      409
    );
  }
  if (input.config.betaAllowList.length > 0 && !input.config.betaAllowList.includes(input.userId)) {
    // Closed beta. The pseudonymous ID is echoed back because it is the only
    // thing the user can quote to ask for access, and it identifies them to
    // the operator without revealing an address to anyone.
    throw new EntitlementError(
      `The included AI service is in a limited beta. Ask for access and quote this ID: ${input.userId}`,
      403
    );
  }

  const document = getFirestore().collection(USERS_COLLECTION).doc(input.userId);
  const existing = (await document.get()).data() as EntitlementDocument | undefined;
  if (existing?.status === "blocked") {
    throw new EntitlementError("This account is not permitted to use the included AI service.", 403);
  }

  const entitlement: Entitlement = {
    userId: input.userId,
    status: "active",
    policyVersion: input.policyVersion,
    consentedAt: input.nowIso,
    updatedAt: input.nowIso
  };
  await document.set(
    {
      status: entitlement.status,
      policyVersion: entitlement.policyVersion,
      consentedAt: entitlement.consentedAt,
      updatedAt: entitlement.updatedAt
    },
    { merge: true }
  );
  return entitlement;
}

/**
 * The check every AI request passes before any message text is read off the
 * wire: an entitlement exists, it is active, and it names the disclosure this
 * deployment currently publishes.
 */
export async function requireCurrentEntitlement(userId: string, config: GatewayConfig): Promise<Entitlement> {
  const snapshot = await getFirestore().collection(USERS_COLLECTION).doc(userId).get();
  const data = snapshot.data() as EntitlementDocument | undefined;
  if (!snapshot.exists || !data) {
    throw new EntitlementError("No hosted-AI consent is on file. Run `gmail setup` to accept it.", 403);
  }
  if (data.status === "blocked") {
    throw new EntitlementError("This account is not permitted to use the included AI service.", 403);
  }
  if (data.status !== "active") {
    throw new EntitlementError("The hosted-AI session was revoked. Run `gmail setup` to reconnect it.", 403);
  }
  if (data.policyVersion !== config.policyVersion) {
    // A materially changed policy is not something an earlier acceptance
    // covers, so this is a hard stop rather than a warning.
    throw new EntitlementError(
      "The data disclosure has changed since you accepted it. Run `gmail setup` to read and accept the current one.",
      403
    );
  }
  return {
    userId,
    status: "active",
    policyVersion: data.policyVersion,
    consentedAt: data.consentedAt ?? "",
    updatedAt: data.updatedAt ?? ""
  };
}

/**
 * Drops a user's entitlement at their own request, and revokes their Firebase
 * refresh tokens so existing sessions stop working on their next request
 * rather than whenever the current ID token expires.
 */
export async function revokeEntitlement(userId: string, nowIso: string): Promise<void> {
  await getFirestore()
    .collection(USERS_COLLECTION)
    .doc(userId)
    .set({ status: "revoked", updatedAt: nowIso, revokedAt: FieldValue.serverTimestamp() }, { merge: true });
  try {
    await getAuth().revokeRefreshTokens(userId);
  } catch {
    // The Firestore status is the authority; a failure here only delays
    // enforcement to the current token's expiry, and must not turn a user's
    // own disconnect request into an error.
  }
}

/** Mints the one-time custom token the CLI exchanges for a refreshable session. */
export async function mintSessionToken(userId: string): Promise<string> {
  try {
    return await getAuth().createCustomToken(userId);
  } catch (error) {
    throw new IdentityError(
      `Could not create a session: ${error instanceof Error ? error.name : "unknown error"}`,
      503
    );
  }
}
