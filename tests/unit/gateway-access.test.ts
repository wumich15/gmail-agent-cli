import { describe, expect, it } from "vitest";
import { decideAccess, parseAccessList } from "../../src/gateway/access.js";

describe("gateway access policy", () => {
  it("is open when no allowlist or blocklist is configured", () => {
    expect(decideAccess({ allow: [], block: [] }, {})).toBe("allowed");
    expect(decideAccess({ allow: [], block: [] }, { email: "anyone@example.com", emailVerified: true })).toBe(
      "allowed"
    );
  });

  it("matches exact addresses and whole domains case-insensitively", () => {
    const policy = { allow: parseAccessList(" Person@Example.com , @Beta.Example "), block: [] };
    expect(decideAccess(policy, { email: "person@example.com", emailVerified: true })).toBe("allowed");
    expect(decideAccess(policy, { email: "SOMEONE@beta.example", emailVerified: true })).toBe("allowed");
    expect(decideAccess(policy, { email: "other@example.com", emailVerified: true })).toBe("not_invited");
  });

  it("lets the blocklist win over the allowlist", () => {
    const policy = { allow: ["@beta.example"], block: ["abuser@beta.example"] };
    expect(decideAccess(policy, { email: "abuser@beta.example", emailVerified: true })).toBe("blocked");
    expect(decideAccess(policy, { email: "guest@beta.example", emailVerified: true })).toBe("allowed");
  });

  it("blocks a named account even when the deployment is otherwise open", () => {
    const policy = { allow: [], block: ["@spam.example"] };
    expect(decideAccess(policy, { email: "bot@spam.example", emailVerified: true })).toBe("blocked");
    expect(decideAccess(policy, { email: "person@example.com", emailVerified: true })).toBe("allowed");
  });

  it("fails closed when a restricted deployment has no verified address to match", () => {
    const policy = { allow: ["@beta.example"], block: [] };
    expect(decideAccess(policy, {})).toBe("unverified_email");
    expect(decideAccess(policy, { email: "person@beta.example", emailVerified: false })).toBe("unverified_email");
  });

  it("ignores blank entries so a trailing comma cannot silently open a deployment", () => {
    expect(parseAccessList("a@example.com,, ,")).toEqual(["a@example.com"]);
    expect(parseAccessList(undefined)).toEqual([]);
    expect(parseAccessList("")).toEqual([]);
  });
});
