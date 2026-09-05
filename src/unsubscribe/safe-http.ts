import { lookup as dnsLookup } from "node:dns";
import { promisify } from "node:util";
import { Agent, fetch as undiciFetch } from "undici";
import { isIPv4, isIPv6 } from "node:net";

const dnsLookupAll = promisify(dnsLookup);

const CONNECT_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type UrlValidationResult = { ok: true; url: URL } | { ok: false; reason: string };

/** Structural checks that don't require a network round trip. */
export function validateUnsubscribeUrl(rawUrl: string): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "unparseable_url" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "not_https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials_in_url" };
  }
  if (url.port !== "" && url.port !== "443") {
    return { ok: false, reason: "non_default_port" };
  }
  return { ok: true, url };
}

/** IPv4/IPv6 loopback, private, link-local, multicast, and reserved ranges. */
export function isPrivateOrReservedIp(address: string): boolean {
  if (isIPv4(address)) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets as [number, number, number, number];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // "this network"
    if (a >= 224) return true; // multicast + reserved (224-255)
    return false;
  }
  if (isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized === "::1") return true; // loopback
    if (normalized.startsWith("::ffff:")) {
      return isPrivateOrReservedIp(normalized.slice("::ffff:".length));
    }
    if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
      return true; // link-local
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local
    if (normalized.startsWith("ff")) return true; // multicast
    return false;
  }
  return true; // unparseable: treat as unsafe
}

export class UnsafeAddressError extends Error {
  constructor(hostname: string, address: string) {
    super(`Resolved address ${address} for ${hostname} is loopback/private/reserved; refusing to connect.`);
    this.name = "UnsafeAddressError";
  }
}

/** Resolves all addresses for a hostname and rejects if any is unsafe. */
export async function resolveAndValidateHostname(hostname: string): Promise<string[]> {
  const records = await dnsLookupAll(hostname, { all: true });
  const addresses = records.map((r) => r.address);
  if (addresses.length === 0) {
    throw new Error(`DNS resolution for ${hostname} returned no addresses.`);
  }
  for (const address of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new UnsafeAddressError(hostname, address);
    }
  }
  return addresses;
}

export type PostOutcome =
  | { kind: "accepted"; status: number }
  | { kind: "rejected"; status: number }
  | { kind: "redirected" }
  | { kind: "unknown"; reason: string };

/**
 * Sends the RFC 8058 one-click unsubscribe POST. Re-resolves and validates
 * the target address immediately before connecting (pinning the connection
 * to that address) to close the DNS-rebinding gap between validation and
 * use. Never follows redirects, sends no cookies/referrer, and enforces
 * short timeouts and a small response-byte cap.
 */
export async function postOneClickUnsubscribe(url: URL): Promise<PostOutcome> {
  let validatedAddresses: string[];
  try {
    validatedAddresses = await resolveAndValidateHostname(url.hostname);
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : "dns_resolution_failed" };
  }

  type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
  const pinnedLookup = (
    _hostname: string,
    optionsOrCallback: unknown,
    maybeCallback?: LookupCallback
  ): void => {
    const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as
      | LookupCallback
      | undefined;
    if (!callback) return;
    const family = isIPv6(validatedAddresses[0]!) ? 6 : 4;
    callback(null, validatedAddresses[0]!, family);
  };

  const agent = new Agent({
    connect: { lookup: pinnedLookup, timeout: CONNECT_TIMEOUT_MS }
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);

  try {
    const response = await undiciFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
      signal: controller.signal,
      dispatcher: agent,
      // No cookies, no browser referrer, no OAuth headers, no email body.
      credentials: "omit"
    });

    if (response.status >= 300 && response.status < 400) {
      return { kind: "redirected" };
    }

    await readBounded(response, MAX_RESPONSE_BYTES);

    if (response.status >= 200 && response.status < 300) {
      return { kind: "accepted", status: response.status };
    }
    return { kind: "rejected", status: response.status };
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : "request_failed" };
  } finally {
    clearTimeout(timeout);
    await agent.close();
  }
}

async function readBounded(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  maxBytes: number
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return;
    }
  }
}

/** Redacts query strings and path-embedded tokens for logs/output. */
export function redactUrlForLogging(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname.replace(/[A-Za-z0-9_-]{12,}/g, "[redacted]")}`;
  } catch {
    return "[unparseable-url]";
  }
}
