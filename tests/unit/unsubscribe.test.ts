import { describe, expect, it } from "vitest";
import { isOneClickPost, parseListUnsubscribeHeader, parseMailtoUri } from "../../src/unsubscribe/headers.js";
import {
  isPrivateOrReservedIp,
  redactUrlForLogging,
  validateUnsubscribeUrl
} from "../../src/unsubscribe/safe-http.js";

describe("parseListUnsubscribeHeader", () => {
  it("parses both an https URL and a mailto in one header", () => {
    const result = parseListUnsubscribeHeader(
      "<https://example.com/unsub?id=1>, <mailto:unsub@example.com?subject=stop>"
    );
    expect(result.httpsUrl).toBe("https://example.com/unsub?id=1");
    expect(result.mailto).toEqual({ address: "unsub@example.com", subject: "stop", body: null });
  });

  it("ignores a plain http URL when there is nothing else", () => {
    const result = parseListUnsubscribeHeader("<http://example.com/unsub>");
    expect(result.httpUrl).toBe("http://example.com/unsub");
    expect(result.httpsUrl).toBeNull();
  });
});

describe("isOneClickPost", () => {
  it("recognizes the RFC 8058 marker", () => {
    expect(isOneClickPost("List-Unsubscribe=One-Click")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isOneClickPost(null)).toBe(false);
    expect(isOneClickPost("something-else")).toBe(false);
  });
});

describe("parseMailtoUri", () => {
  it("parses address, subject, and body while ignoring cc/bcc", () => {
    const result = parseMailtoUri(
      "mailto:unsub@example.com?subject=Unsubscribe&body=please&cc=other@example.com"
    );
    expect(result).toEqual({ address: "unsub@example.com", subject: "Unsubscribe", body: "please" });
  });

  it("rejects multiple recipients", () => {
    expect(parseMailtoUri("mailto:a@example.com,b@example.com")).toBeNull();
  });

  it("rejects CR/LF injection attempts", () => {
    expect(parseMailtoUri("mailto:a@example.com?subject=x%0d%0aBcc:evil@example.com")).toBeNull();
  });

  it("rejects a malformed address", () => {
    expect(parseMailtoUri("mailto:not-an-address")).toBeNull();
  });
});

describe("validateUnsubscribeUrl", () => {
  it("accepts a plain https URL", () => {
    const result = validateUnsubscribeUrl("https://example.com/unsub");
    expect(result.ok).toBe(true);
  });

  it("rejects http", () => {
    expect(validateUnsubscribeUrl("http://example.com/unsub")).toEqual({
      ok: false,
      reason: "not_https"
    });
  });

  it("rejects credentials embedded in the URL", () => {
    expect(validateUnsubscribeUrl("https://user:pass@example.com/unsub").ok).toBe(false);
  });

  it("rejects a non-default port", () => {
    expect(validateUnsubscribeUrl("https://example.com:8443/unsub").ok).toBe(false);
  });
});

describe("isPrivateOrReservedIp", () => {
  it("flags loopback, private, and link-local IPv4", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.0.0.5")).toBe(true);
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.1.1")).toBe(true);
  });

  it("allows an ordinary public IPv4 address", () => {
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
  });

  it("flags RFC 6598 shared address space (carrier-grade NAT), a common SSRF-checklist gap", () => {
    expect(isPrivateOrReservedIp("100.64.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("100.100.100.100")).toBe(true);
    expect(isPrivateOrReservedIp("100.127.255.255")).toBe(true);
    // Just outside the /10 range on either side must stay unaffected.
    expect(isPrivateOrReservedIp("100.63.255.255")).toBe(false);
    expect(isPrivateOrReservedIp("100.128.0.0")).toBe(false);
  });

  it("flags IPv6 loopback and unique-local", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd00::1")).toBe(true);
  });
});

describe("redactUrlForLogging", () => {
  it("strips query strings and long path tokens", () => {
    const redacted = redactUrlForLogging(
      "https://example.com/unsub/abcdefghijklmnop?token=secretvalue123"
    );
    expect(redacted).not.toContain("secretvalue123");
    expect(redacted).not.toContain("abcdefghijklmnop");
  });
});
