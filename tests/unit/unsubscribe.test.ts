import { runScenarios } from "../helpers/scenarios.js";
import { describe, expect, it } from "vitest";
import { isOneClickPost, parseListUnsubscribeHeader, parseMailtoUri } from "../../src/unsubscribe/headers.js";
import {
  isPrivateOrReservedIp,
  redactUrlForLogging,
  validateUnsubscribeUrl
} from "../../src/unsubscribe/safe-http.js";

describe("unsubscribe header parsing and safe-http validation", () => {
  it("preserves all 17 scenarios", async () => {
    await runScenarios([
      { name: "parses both an https URL and a mailto in one List-Unsubscribe header", run: () => {
        const result = parseListUnsubscribeHeader(
          "<https://example.com/unsub?id=1>, <mailto:unsub@example.com?subject=stop>"
        );
        expect(result.httpsUrl).toBe("https://example.com/unsub?id=1");
        expect(result.mailto).toEqual({ address: "unsub@example.com", subject: "stop", body: null });
      } },
      { name: "ignores a plain http URL when there is nothing else", run: () => {
        const result = parseListUnsubscribeHeader("<http://example.com/unsub>");
        expect(result.httpUrl).toBe("http://example.com/unsub");
        expect(result.httpsUrl).toBeNull();
      } },
      { name: "isOneClickPost recognizes the RFC 8058 marker", run: () => {
        expect(isOneClickPost("List-Unsubscribe=One-Click")).toBe(true);
      } },
      { name: "isOneClickPost rejects anything else", run: () => {
        expect(isOneClickPost(null)).toBe(false);
        expect(isOneClickPost("something-else")).toBe(false);
      } },
      { name: "parseMailtoUri parses address, subject, and body while ignoring cc/bcc", run: () => {
        const result = parseMailtoUri(
          "mailto:unsub@example.com?subject=Unsubscribe&body=please&cc=other@example.com"
        );
        expect(result).toEqual({ address: "unsub@example.com", subject: "Unsubscribe", body: "please" });
      } },
      { name: "parseMailtoUri rejects multiple recipients", run: () => {
        expect(parseMailtoUri("mailto:a@example.com,b@example.com")).toBeNull();
      } },
      { name: "parseMailtoUri rejects CR/LF injection attempts", run: () => {
        expect(parseMailtoUri("mailto:a@example.com?subject=x%0d%0aBcc:evil@example.com")).toBeNull();
      } },
      { name: "parseMailtoUri rejects a malformed address", run: () => {
        expect(parseMailtoUri("mailto:not-an-address")).toBeNull();
      } },
      { name: "validateUnsubscribeUrl accepts a plain https URL", run: () => {
        expect(validateUnsubscribeUrl("https://example.com/unsub").ok).toBe(true);
      } },
      { name: "validateUnsubscribeUrl rejects http", run: () => {
        expect(validateUnsubscribeUrl("http://example.com/unsub")).toEqual({ ok: false, reason: "not_https" });
      } },
      { name: "validateUnsubscribeUrl rejects credentials embedded in the URL", run: () => {
        expect(validateUnsubscribeUrl("https://user:pass@example.com/unsub").ok).toBe(false);
      } },
      { name: "validateUnsubscribeUrl rejects a non-default port", run: () => {
        expect(validateUnsubscribeUrl("https://example.com:8443/unsub").ok).toBe(false);
      } },
      { name: "isPrivateOrReservedIp flags loopback, private, and link-local IPv4, allows public IPv4", run: () => {
        expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
        expect(isPrivateOrReservedIp("10.0.0.5")).toBe(true);
        expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
        expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
        expect(isPrivateOrReservedIp("169.254.1.1")).toBe(true);
        expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
      } },
      { name: "isPrivateOrReservedIp flags the IPv6 unspecified address, which reaches the local host", run: () => {
        expect(isPrivateOrReservedIp("::")).toBe(true);
        expect(isPrivateOrReservedIp("0:0:0:0:0:0:0:0")).toBe(true);
        expect(isPrivateOrReservedIp("::1")).toBe(true);
        expect(isPrivateOrReservedIp("fd00::1")).toBe(true);
        expect(isPrivateOrReservedIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
      } },
      { name: "isPrivateOrReservedIp flags RFC 6598 shared address space (carrier-grade NAT), a common SSRF-checklist gap", run: () => {
        expect(isPrivateOrReservedIp("100.64.0.1")).toBe(true);
        expect(isPrivateOrReservedIp("100.100.100.100")).toBe(true);
        expect(isPrivateOrReservedIp("100.127.255.255")).toBe(true);
        // Just outside the /10 range on either side must stay unaffected.
        expect(isPrivateOrReservedIp("100.63.255.255")).toBe(false);
        expect(isPrivateOrReservedIp("100.128.0.0")).toBe(false);
      } },
      { name: "isPrivateOrReservedIp flags IPv6 loopback and unique-local", run: () => {
        expect(isPrivateOrReservedIp("::1")).toBe(true);
        expect(isPrivateOrReservedIp("fd00::1")).toBe(true);
      } },
      { name: "redactUrlForLogging strips query strings and long path tokens", run: () => {
        const redacted = redactUrlForLogging("https://example.com/unsub/abcdefghijklmnop?token=secretvalue123");
        expect(redacted).not.toContain("secretvalue123");
        expect(redacted).not.toContain("abcdefghijklmnop");
      } }
    ]);
  });
});
