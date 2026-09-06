/**
 * Lightweight parsing of Gmail's `Authentication-Results` header, used only
 * to bind/validate persistent important-rule matchers against an aligned
 * passing DKIM or DMARC identity. This is supporting evidence from Gmail's
 * own verification, not a substitute for the independent DKIM verifier the
 * unsubscribe subsystem uses before a RFC 8058 one-click POST.
 */
export interface AuthResultEntry {
  mechanism: "dkim" | "dmarc" | "spf";
  result: string;
  domain: string | null;
}

export function parseAuthenticationResults(headerValue: string | null): AuthResultEntry[] {
  if (headerValue === null) {
    return [];
  }
  const entries: AuthResultEntry[] = [];

  for (const match of headerValue.matchAll(/\bdkim=([a-z]+)([^;]*)/gi)) {
    const result = match[1]!.toLowerCase();
    const rest = match[2] ?? "";
    const domainMatch = /header\.(?:d|i)=@?([a-zA-Z0-9.-]+)/.exec(rest);
    entries.push({ mechanism: "dkim", result, domain: domainMatch?.[1]?.toLowerCase() ?? null });
  }

  for (const match of headerValue.matchAll(/\bdmarc=([a-z]+)([^;]*)/gi)) {
    const result = match[1]!.toLowerCase();
    const rest = match[2] ?? "";
    const domainMatch = /header\.from=([a-zA-Z0-9.-]+)/.exec(rest);
    entries.push({ mechanism: "dmarc", result, domain: domainMatch?.[1]?.toLowerCase() ?? null });
  }

  return entries;
}

/** True if there is a passing DKIM or DMARC result aligned to the given domain. */
export function hasAlignedPassingAuth(headerValue: string | null, domain: string): boolean {
  const normalizedDomain = domain.toLowerCase();
  return parseAuthenticationResults(headerValue).some(
    (entry) =>
      (entry.mechanism === "dkim" || entry.mechanism === "dmarc") &&
      entry.result === "pass" &&
      entry.domain === normalizedDomain
  );
}

/** Picks the best available (dkim, then dmarc) passing aligned domain to bind a new rule to. */
export function selectAuthBindingDomain(
  headerValue: string | null,
  senderAddressDomain: string | null
): { mechanism: "dkim" | "dmarc"; domain: string } | null {
  const entries = parseAuthenticationResults(headerValue);
  const passing = entries.filter((e) => e.result === "pass" && e.domain !== null);

  // "Aligned" means the passing signature's own domain actually matches
  // the sender's address domain — not just any passing signature found
  // anywhere in the header. A message can carry a passing DKIM signature
  // for an unrelated domain (e.g. a shared ESP that DKIM-signs as its own
  // domain rather than the customer's), and accepting that as "aligned"
  // would let anyone else who also sends through that same ESP forge the
  // sender address and still pass this check — exactly the impersonation
  // this binding exists to prevent.
  const dkim = passing.find((e) => e.mechanism === "dkim" && e.domain === senderAddressDomain);
  if (dkim?.domain) {
    return { mechanism: "dkim", domain: dkim.domain };
  }
  const dmarc = passing.find((e) => e.mechanism === "dmarc" && e.domain === senderAddressDomain);
  if (dmarc?.domain) {
    return { mechanism: "dmarc", domain: dmarc.domain };
  }
  return null;
}
