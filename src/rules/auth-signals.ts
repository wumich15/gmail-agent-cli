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

  const dkim = passing.find((e) => e.mechanism === "dkim");
  if (dkim?.domain) {
    return { mechanism: "dkim", domain: dkim.domain };
  }
  const dmarc = passing.find((e) => e.mechanism === "dmarc");
  if (dmarc?.domain && dmarc.domain === senderAddressDomain) {
    return { mechanism: "dmarc", domain: dmarc.domain };
  }
  return null;
}
