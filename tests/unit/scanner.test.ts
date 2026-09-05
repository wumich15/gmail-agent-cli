import { describe, expect, it } from "vitest";
import { historyIdGreaterThan } from "../../src/gmail/scanner.js";

describe("historyIdGreaterThan", () => {
  it("compares numerically, not lexicographically", () => {
    // A pure string comparison would say "99" > "100" (wrong).
    expect(historyIdGreaterThan("100", "99")).toBe(true);
    expect(historyIdGreaterThan("99", "100")).toBe(false);
  });

  it("handles values beyond Number.MAX_SAFE_INTEGER", () => {
    expect(historyIdGreaterThan("9007199254740993", "9007199254740992")).toBe(true);
  });

  it("is false for equal values", () => {
    expect(historyIdGreaterThan("42", "42")).toBe(false);
  });
});
