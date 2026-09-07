import type { NormalizedMessage } from "./models.js";
import { hasAlignedPassingAuth } from "../rules/auth-signals.js";

/**
 * Content patterns for the transactional categories CLAUDE.md names under
 * "Local signals and protection": account security, fraud, payments,
 * travel, medical, legal, deliveries, appointments, deadlines, and
 * receipts. Matched against subject + body only after authentication
 * passes (see hasAuthenticatedHighRiskSignal below) — a keyword match
 * alone is deliberately never sufficient, since a malicious unauthenticated
 * sender could otherwise embed one of these words purely to evade cleanup.
 */
const HIGH_RISK_CONTENT_PATTERN =
  /\b(security alert|verify your (account|identity)|suspicious (activity|sign-?in|login)|new sign-?in|password (reset|changed|expir\w*)|two-factor|2fa|account (suspended|locked|compromised)|unauthorized (access|charge|transaction)|fraud alert|payment (due|failed|received|confirmation|declined)|invoice|receipt|order confirmation|refund (issued|processed)|itinerary|boarding pass|flight (confirmation|change|cancell?ed)|reservation confirm\w*|booking confirm\w*|appointment (confirmation|reminder|scheduled)|prescription (ready|refill)|lab results|legal notice|subpoena|court date|final notice|deadline|delivery (attempted|scheduled|confirmation)|package (delivered|out for delivery)|tracking number|shipment (confirmation|delayed))\b/i;

/**
 * Deterministic, non-AI safety-veto signal (see CLAUDE.md's "Deterministic
 * action policy" step 4 and "Local signals and protection"): true only when
 * BOTH (a) the sender's own domain has a currently-passing, aligned
 * DKIM/DMARC result on this message, and (b) the subject/body matches a
 * high-risk transactional pattern. Computed entirely in code from headers
 * and content, never from the AI classifier's output — the wire schema no
 * longer even asks the model for reason codes, and CLAUDE.md is explicit
 * that a keyword alone (without authentication) must never be enough to
 * trigger this veto.
 */
export function hasAuthenticatedHighRiskSignal(message: NormalizedMessage): boolean {
  const domain = message.from.address?.split("@")[1]?.toLowerCase() ?? null;
  if (!domain) {
    return false;
  }
  if (!hasAlignedPassingAuth(message.authenticationResults, domain)) {
    return false;
  }
  const text = `${message.subject}\n${message.bodyText ?? message.snippet}`;
  return HIGH_RISK_CONTENT_PATTERN.test(text);
}
