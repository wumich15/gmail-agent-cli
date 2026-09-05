export interface ParsedListUnsubscribe {
  httpsUrl: string | null;
  mailto: { address: string; subject: string | null; body: string | null } | null;
  httpUrl: string | null;
}

/** Parses the (possibly multi-value, comma-separated) List-Unsubscribe header. */
export function parseListUnsubscribeHeader(headerValue: string): ParsedListUnsubscribe {
  const result: ParsedListUnsubscribe = { httpsUrl: null, mailto: null, httpUrl: null };
  for (const raw of splitAngleBracketEntries(headerValue)) {
    if (/^https:\/\//i.test(raw)) {
      result.httpsUrl ??= raw;
    } else if (/^http:\/\//i.test(raw)) {
      result.httpUrl ??= raw;
    } else if (/^mailto:/i.test(raw)) {
      const parsed = parseMailtoUri(raw);
      if (parsed) {
        result.mailto ??= parsed;
      }
    }
  }
  return result;
}

function splitAngleBracketEntries(headerValue: string): string[] {
  const entries: string[] = [];
  for (const match of headerValue.matchAll(/<([^<>]+)>/g)) {
    entries.push(match[1]!.trim());
  }
  return entries;
}

export function isOneClickPost(listUnsubscribePost: string | null): boolean {
  if (listUnsubscribePost === null) {
    return false;
  }
  return /List-Unsubscribe\s*=\s*One-Click/i.test(listUnsubscribePost);
}

const CRLF_PATTERN = /[\r\n]/;

/**
 * Decodes and validates a mailto: URI to a single exact destination with
 * bounded subject/body. Rejects CR/LF (header injection), additional
 * recipients, and ignores cc/bcc/attachment fields entirely.
 */
export function parseMailtoUri(
  uri: string
): { address: string; subject: string | null; body: string | null } | null {
  if (!/^mailto:/i.test(uri) || CRLF_PATTERN.test(uri)) {
    return null;
  }
  let rest = uri.slice("mailto:".length);
  const queryIndex = rest.indexOf("?");
  const addressPart = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? "" : rest.slice(queryIndex + 1);

  let address: string;
  try {
    address = decodeURIComponent(addressPart);
  } catch {
    return null;
  }
  if (address.length === 0 || address.includes(",") || CRLF_PATTERN.test(address)) {
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return null;
  }

  let subject: string | null = null;
  let body: string | null = null;
  for (const pair of queryPart.split("&")) {
    if (pair.length === 0) continue;
    const [rawKey, rawValue = ""] = pair.split("=");
    const key = rawKey?.toLowerCase();
    let value: string;
    try {
      value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    } catch {
      continue;
    }
    if (CRLF_PATTERN.test(value)) {
      return null;
    }
    if (key === "subject") {
      subject = value.slice(0, 200);
    } else if (key === "body") {
      body = value.slice(0, 1000);
    }
    // cc, bcc, and any other field are intentionally ignored.
  }

  return { address: address.toLowerCase(), subject, body };
}
