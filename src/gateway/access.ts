/**
 * Beta access control for the publisher gateway.
 *
 * Phase 5 of the production plan requires a decision about who may use
 * Included GPT during a limited beta. Google's ID token proves *which Google
 * account* is calling; it is not proof that an unmodified official build made
 * the request, so this is an audience control, not an integrity control — the
 * quota, model allowlist, and narrow request schema remain the spend and abuse
 * boundaries regardless of who is allowed in.
 *
 * Entries are exact addresses (`person@example.com`) or whole domains
 * (`@example.com`), compared case-insensitively. The verified address is used
 * for comparison only: it is never written to the quota database, the metrics,
 * or the request log, where the pseudonymous subject hash is used instead.
 */
export interface GatewayAccessPolicy {
  /** Empty means "every signed-in Google account", i.e. general availability. */
  allow: readonly string[];
  /** Always wins over the allowlist, so one abusive account can be cut off immediately. */
  block: readonly string[];
}

export function parseAccessList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export type AccessDecision = "allowed" | "blocked" | "not_invited" | "unverified_email";

export function decideAccess(
  policy: GatewayAccessPolicy,
  identity: { email?: string | undefined; emailVerified?: boolean | undefined }
): AccessDecision {
  const restricted = policy.allow.length > 0 || policy.block.length > 0;
  if (!restricted) return "allowed";

  const email = identity.email?.trim().toLowerCase();
  // A restricted deployment must fail closed: without a verified address there
  // is nothing to match an allowlist against, and guessing would let anyone in.
  if (!email || identity.emailVerified === false) return "unverified_email";

  const domain = email.slice(email.lastIndexOf("@"));
  const matches = (list: readonly string[]): boolean => list.includes(email) || list.includes(domain);

  if (matches(policy.block)) return "blocked";
  if (policy.allow.length === 0) return "allowed";
  return matches(policy.allow) ? "allowed" : "not_invited";
}
