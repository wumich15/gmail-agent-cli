import { runScenarios } from "../helpers/scenarios.js";
import { describe, expect, it } from "vitest";
import { evaluateMatcher, evaluateRuleGroup } from "../../src/rules/matcher.js";
import {
  findConflictingRuleGroup,
  groupBySubscriptionIdentity,
  proposeMatcher
} from "../../src/rules/resolver.js";
import { buildNormalizedMessage, headerMapFromList } from "../../src/gmail/normalize.js";
import type { NormalizedMessage, RuleGroup } from "../../src/core/models.js";

function message(overrides: Partial<Parameters<typeof buildNormalizedMessage>[0]> = {}): NormalizedMessage {
  return buildNormalizedMessage({
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    historyId: "1",
    internalDate: "1000",
    labelIds: [],
    snippet: "",
    headers: headerMapFromList([{ name: "From", value: "news@list.example.com" }]),
    htmlBody: null,
    plainBody: null,
    userEmail: "me@example.com",
    threadHasUserSentMessage: false,
    ...overrides
  });
}

describe("evaluateMatcher", () => {
  it("preserves all 5 scenarios", async () => {
    await runScenarios([
      { name: "matches an exact normalized from_address", run: () => {
    const m = message();
    const result = evaluateMatcher(
      { kind: "from_address", normalizedValue: "news@list.example.com", authBinding: null },
      m
    );
    expect(result).toBe("matched");
  } },
      { name: "does not match a different address", run: () => {
    const m = message();
    const result = evaluateMatcher(
      { kind: "from_address", normalizedValue: "other@example.com", authBinding: null },
      m
    );
    expect(result).toBe("no_match");
  } },
      { name: "matches list_id from the bracketed value", run: () => {
    const m = message({
      headers: headerMapFromList([
        { name: "From", value: "news@list.example.com" },
        { name: "List-ID", value: "Newsletter <newsletter.list.example.com>" }
      ])
    });
    const result = evaluateMatcher(
      { kind: "list_id", normalizedValue: "newsletter.list.example.com", authBinding: null },
      m
    );
    expect(result).toBe("matched");
  } },
      { name: "reports auth_failed for a bound important matcher with no passing aligned auth", run: () => {
    const m = message();
    const result = evaluateMatcher(
      {
        kind: "from_address",
        normalizedValue: "news@list.example.com",
        authBinding: { mechanism: "dkim", domain: "list.example.com" }
      },
      m
    );
    expect(result).toBe("auth_failed");
  } },
      { name: "matches a bound important matcher when DKIM passes for the aligned domain", run: () => {
    const m = message({
      headers: headerMapFromList([
        { name: "From", value: "news@list.example.com" },
        {
          name: "Authentication-Results",
          value: "mx.google.com; dkim=pass header.i=@list.example.com header.s=sel"
        }
      ])
    });
    const result = evaluateMatcher(
      {
        kind: "from_address",
        normalizedValue: "news@list.example.com",
        authBinding: { mechanism: "dkim", domain: "list.example.com" }
      },
      m
    );
    expect(result).toBe("matched");
  } }
    ]);
  });
});

describe("evaluateRuleGroup", () => {
  it("preserves all 2 scenarios", async () => {
    await runScenarios([
      { name: "matches if any matcher in the group matches (OR semantics)", run: () => {
    const group: RuleGroup = {
      id: "r1",
      accountHash: "a",
      categoryName: "LinkedIn",
      action: "spam",
      enabled: true,
      matchers: [
        { kind: "from_address", normalizedValue: "nomatch@example.com", authBinding: null },
        { kind: "from_address", normalizedValue: "news@list.example.com", authBinding: null }
      ],
      createdAt: "",
      updatedAt: ""
    };
    expect(evaluateRuleGroup(group, message())).toBe("matched");
  } },
      { name: "ignores disabled rule groups", run: () => {
    const group: RuleGroup = {
      id: "r1",
      accountHash: "a",
      categoryName: "LinkedIn",
      action: "spam",
      enabled: false,
      matchers: [{ kind: "from_address", normalizedValue: "news@list.example.com", authBinding: null }],
      createdAt: "",
      updatedAt: ""
    };
    expect(evaluateRuleGroup(group, message())).toBe("no_match");
  } }
    ]);
  });
});

describe("groupBySubscriptionIdentity and proposeMatcher", () => {
  it("preserves all 2 scenarios", async () => {
    await runScenarios([
      { name: "prefers List-ID as identity when present", run: () => {
    const m = message({
      headers: headerMapFromList([
        { name: "From", value: "news@list.example.com" },
        { name: "List-ID", value: "<newsletter.list.example.com>" }
      ])
    });
    const [identity] = groupBySubscriptionIdentity([m]);
    expect(identity!.listId).toBe("newsletter.list.example.com");
    expect(proposeMatcher(identity!)).toEqual({
      kind: "list_id",
      normalizedValue: "newsletter.list.example.com",
      authBinding: null
    });
  } },
      { name: "falls back to sender address when there is no List-ID", run: () => {
    const [identity] = groupBySubscriptionIdentity([message()]);
    expect(identity!.listId).toBeNull();
    expect(proposeMatcher(identity!)).toEqual({
      kind: "from_address",
      normalizedValue: "news@list.example.com",
      authBinding: null
    });
  } }
    ]);
  });
});

describe("findConflictingRuleGroup", () => {
  it("preserves all 2 scenarios", async () => {
    await runScenarios([
      { name: "rejects a spam rule that overlaps an existing important rule", run: () => {
    const important: RuleGroup = {
      id: "r1",
      accountHash: "a",
      categoryName: "Boss",
      action: "important",
      enabled: true,
      matchers: [{ kind: "from_address", normalizedValue: "boss@example.com", authBinding: null }],
      createdAt: "",
      updatedAt: ""
    };
    const conflict = findConflictingRuleGroup(
      [important],
      "spam",
      [{ kind: "from_address", normalizedValue: "boss@example.com", authBinding: null }]
    );
    expect(conflict).toBe(important);
  } },
      { name: "returns null when there is no overlap", run: () => {
    const conflict = findConflictingRuleGroup(
      [],
      "spam",
      [{ kind: "from_address", normalizedValue: "boss@example.com", authBinding: null }]
    );
    expect(conflict).toBeNull();
  } }
    ]);
  });
});
