import { describe, expect, it } from "vitest";
import { hasAlignedPassingAuth, parseAuthenticationResults, selectAuthBindingDomain } from "../../src/rules/auth-signals.js";

describe("parseAuthenticationResults", () => {
  it("extracts dkim and dmarc entries with their result and domain", () => {
    const header = "mx.google.com; dkim=pass header.i=@example.com header.s=sel; dmarc=pass header.from=example.com";
    const entries = parseAuthenticationResults(header);
    expect(entries).toContainEqual({ mechanism: "dkim", result: "pass", domain: "example.com" });
    expect(entries).toContainEqual({ mechanism: "dmarc", result: "pass", domain: "example.com" });
  });

  it("returns an empty array for null", () => {
    expect(parseAuthenticationResults(null)).toEqual([]);
  });
});

describe("hasAlignedPassingAuth", () => {
  it("is true for a passing, aligned dkim result", () => {
    expect(hasAlignedPassingAuth("dkim=pass header.i=@example.com", "example.com")).toBe(true);
  });

  it("is false when the passing domain doesn't match", () => {
    expect(hasAlignedPassingAuth("dkim=pass header.i=@other.com", "example.com")).toBe(false);
  });
});

describe("selectAuthBindingDomain", () => {
  it("binds to a passing DKIM domain that matches the sender's own address domain", () => {
    const binding = selectAuthBindingDomain("dkim=pass header.i=@example.com", "example.com");
    expect(binding).toEqual({ mechanism: "dkim", domain: "example.com" });
  });

  it("does NOT bind to a passing DKIM signature for an unrelated (unaligned) domain — regression for the impersonation gap", () => {
    // A shared ESP DKIM-signs as its own domain, not the customer's. A
    // passing signature for that unrelated domain must never be accepted
    // as "aligned" just because it's present and passing somewhere in the
    // header — otherwise anyone else sending through the same ESP could
    // forge the sender address and still satisfy this binding.
    const binding = selectAuthBindingDomain("dkim=pass header.i=@shared-esp.example", "bigcorp.com");
    expect(binding).toBeNull();
  });

  it("falls back to an aligned passing DMARC result when DKIM isn't aligned", () => {
    const header = "dkim=pass header.i=@shared-esp.example; dmarc=pass header.from=bigcorp.com";
    const binding = selectAuthBindingDomain(header, "bigcorp.com");
    expect(binding).toEqual({ mechanism: "dmarc", domain: "bigcorp.com" });
  });

  it("does not bind to a passing DMARC result for an unrelated domain either", () => {
    const binding = selectAuthBindingDomain("dmarc=pass header.from=other.com", "bigcorp.com");
    expect(binding).toBeNull();
  });

  it("returns null when nothing passes", () => {
    expect(selectAuthBindingDomain("dkim=fail header.i=@example.com", "example.com")).toBeNull();
    expect(selectAuthBindingDomain(null, "example.com")).toBeNull();
  });
});
