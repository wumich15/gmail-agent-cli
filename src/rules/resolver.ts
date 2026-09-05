import type { NormalizedMessage, RuleAction, RuleGroup, RuleMatcher } from "../core/models.js";
import { domainOf, normalizeAddress, normalizeListId } from "./matcher.js";
import { selectAuthBindingDomain } from "./auth-signals.js";

export interface SubscriptionIdentity {
  /** Stable dedup/display key: the List-ID when present, else the sender address. */
  key: string;
  listId: string | null;
  fromAddress: string | null;
  displayLabel: string;
  sampleMessageIds: string[];
}

/**
 * Groups candidate messages into subscription identities. Prefers List-ID
 * as identity; falls back to an exact normalized sender address. Never
 * infers a whole registrable domain here — that requires a separate,
 * explicit confirmation step the CLI drives.
 */
export function groupBySubscriptionIdentity(
  messages: readonly NormalizedMessage[]
): SubscriptionIdentity[] {
  const byKey = new Map<string, SubscriptionIdentity>();

  for (const message of messages) {
    const listId = message.listId ? normalizeListId(message.listId) : null;
    const fromAddress = message.from.address ? normalizeAddress(message.from.address) : null;
    const key = listId !== null ? `list_id:${listId}` : fromAddress !== null ? `from:${fromAddress}` : null;
    if (key === null) {
      continue;
    }
    const existing = byKey.get(key);
    if (existing) {
      existing.sampleMessageIds.push(message.gmailMessageId);
      continue;
    }
    byKey.set(key, {
      key,
      listId,
      fromAddress,
      displayLabel: listId ?? fromAddress ?? key,
      sampleMessageIds: [message.gmailMessageId]
    });
  }

  return [...byKey.values()];
}

/** Proposes the narrow (non-domain-wide) matcher for a subscription identity. */
export function proposeMatcher(identity: SubscriptionIdentity): RuleMatcher {
  if (identity.listId !== null) {
    return { kind: "list_id", normalizedValue: identity.listId, authBinding: null };
  }
  return { kind: "from_address", normalizedValue: identity.fromAddress!, authBinding: null };
}

/**
 * Proposes an important-rule matcher bound to an aligned passing DKIM/DMARC
 * identity observed on the given message, per the anti-spoofing requirement
 * for persistent important rules. Returns null if no aligned pass exists.
 */
export function proposeBoundImportantMatcher(
  identity: SubscriptionIdentity,
  observedMessage: NormalizedMessage
): RuleMatcher | null {
  const base = proposeMatcher(identity);
  const senderDomain = observedMessage.from.address ? domainOf(observedMessage.from.address) : null;
  const binding = selectAuthBindingDomain(observedMessage.authenticationResults, senderDomain);
  if (binding === null) {
    return null;
  }
  return { ...base, authBinding: binding };
}

/**
 * A domain-wide matcher requires the caller to have obtained explicit
 * confirmation naming the exact domain; this is the only place that
 * constructs one, so it stays deliberate rather than an inference default.
 */
export function explicitlyConfirmedDomainMatcher(domain: string): RuleMatcher {
  return { kind: "from_domain", normalizedValue: domain.trim().toLowerCase(), authBinding: null };
}

/**
 * Finds an existing enabled rule group of the opposite action that shares
 * any matcher (same kind + normalized value) with the proposed matchers.
 * Creating a spam rule that overlaps an important rule (or vice versa)
 * must fail with a clear conflict rather than silently choosing one.
 */
export function findConflictingRuleGroup(
  existingGroups: readonly RuleGroup[],
  proposedAction: RuleAction,
  proposedMatchers: readonly RuleMatcher[]
): RuleGroup | null {
  const opposite: RuleAction = proposedAction === "spam" ? "important" : "spam";
  for (const group of existingGroups) {
    if (!group.enabled || group.action !== opposite) {
      continue;
    }
    const overlaps = group.matchers.some((existingMatcher) =>
      proposedMatchers.some(
        (proposed) =>
          proposed.kind === existingMatcher.kind &&
          proposed.normalizedValue === existingMatcher.normalizedValue
      )
    );
    if (overlaps) {
      return group;
    }
  }
  return null;
}
