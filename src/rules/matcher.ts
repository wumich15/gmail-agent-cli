import type { NormalizedMessage, RuleGroup, RuleMatcher } from "../core/models.js";
import { hasAlignedPassingAuth } from "./auth-signals.js";

export function normalizeListId(raw: string): string {
  // List-ID values look like: "Display Name <list.id.example.com>"
  const match = /<([^>]+)>/.exec(raw);
  return (match?.[1] ?? raw).trim().toLowerCase();
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at === -1 ? null : address.slice(at + 1).toLowerCase();
}

export function normalizeSubjectPrefix(prefix: string): string {
  return prefix.trim().toLowerCase();
}

export type MatcherResult = "matched" | "auth_failed" | "no_match";

/**
 * Evaluates one matcher against a message. For an important matcher with a
 * stored authentication binding, a structural match without a currently
 * passing aligned DKIM/DMARC result returns "auth_failed" rather than
 * "matched", per the design's anti-spoofing requirement.
 */
export function evaluateMatcher(matcher: RuleMatcher, message: NormalizedMessage): MatcherResult {
  let structuralMatch = false;

  switch (matcher.kind) {
    case "list_id":
      structuralMatch =
        message.listId !== null && normalizeListId(message.listId) === matcher.normalizedValue;
      break;
    case "from_address":
      structuralMatch =
        message.from.address !== null &&
        normalizeAddress(message.from.address) === matcher.normalizedValue;
      break;
    case "from_domain": {
      const domain = message.from.address ? domainOf(message.from.address) : null;
      structuralMatch = domain !== null && domain === matcher.normalizedValue;
      break;
    }
    case "subject_prefix":
      // Both sides go through the same normalizer: a stored prefix and an
      // incoming subject must agree on what "normalized" means, or a rule
      // silently stops matching the day one of the two is changed.
      structuralMatch = normalizeSubjectPrefix(message.subject).startsWith(matcher.normalizedValue);
      break;
  }

  if (!structuralMatch) {
    return "no_match";
  }

  if (matcher.authBinding !== null) {
    const aligned = hasAlignedPassingAuth(message.authenticationResults, matcher.authBinding.domain);
    return aligned ? "matched" : "auth_failed";
  }

  return "matched";
}

export interface RuleGroupMatchResult {
  ruleGroup: RuleGroup;
  result: MatcherResult;
}

/**
 * A rule group matches if any of its matchers match (OR semantics), since a
 * category such as "LinkedIn" may bundle several concrete subscription
 * identities. An auth_failed result on any matcher, with no other matcher
 * fully matching, still reports auth_failed so callers route to Review
 * rather than silently ignoring a spoofing attempt.
 */
export function evaluateRuleGroup(ruleGroup: RuleGroup, message: NormalizedMessage): MatcherResult {
  if (!ruleGroup.enabled) {
    return "no_match";
  }
  let sawAuthFailed = false;
  for (const matcher of ruleGroup.matchers) {
    const result = evaluateMatcher(matcher, message);
    if (result === "matched") {
      return "matched";
    }
    if (result === "auth_failed") {
      sawAuthFailed = true;
    }
  }
  return sawAuthFailed ? "auth_failed" : "no_match";
}

export function findMatchingRuleGroups(
  ruleGroups: readonly RuleGroup[],
  message: NormalizedMessage
): RuleGroupMatchResult[] {
  return ruleGroups
    .map((ruleGroup) => ({ ruleGroup, result: evaluateRuleGroup(ruleGroup, message) }))
    .filter((r) => r.result !== "no_match");
}
