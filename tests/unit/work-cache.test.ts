import { describe, expect, it } from "vitest";
import { selectCachedBacklogStubs, type CurrentCacheVersions } from "../../src/commands/work.js";
import type { CachedMessageRecord } from "../../src/state/repositories/messages.js";

const versions: CurrentCacheVersions = {
  classifierVersion: "openai:test",
  promptVersion: "prompt-v5",
  schemaVersion: "schema-v5",
  policyVersion: "policy-v4:context"
};

function row(overrides: Partial<CachedMessageRecord> = {}): CachedMessageRecord {
  return {
    accountHash: "account",
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    contentHash: "hash",
    labelSnapshot: ["INBOX"],
    classifierVersion: versions.classifierVersion,
    promptVersion: versions.promptVersion,
    schemaVersion: versions.schemaVersion,
    policyVersion: versions.policyVersion,
    assessmentKind: "personal_routine",
    assessmentConfidence: 0,
    importanceScore: 0,
    importanceConfidence: 0,
    reasonCodes: [],
    processedAt: "now",
    subject: "Subject",
    senderDisplay: "sender@example.com",
    internalDate: "1000",
    category: null,
    assessmentHadEvent: false,
    ...overrides
  };
}

describe("selectCachedBacklogStubs", () => {
  it("queues a cache-only placeholder but skips a matching reusable assessment", () => {
    const placeholder = row({
      gmailMessageId: "pending",
      classifierVersion: null,
      promptVersion: null,
      schemaVersion: null,
      policyVersion: null,
      assessmentKind: null,
      assessmentHadEvent: null
    });
    const reusable = row({ gmailMessageId: "ready" });

    expect(selectCachedBacklogStubs([placeholder, reusable], versions)).toEqual([
      { id: "pending", threadId: "t1" }
    ]);
  });

  it("does not repeatedly hydrate a completed deterministic/rules-only evaluation", () => {
    const evaluatedWithoutAi = row({ assessmentKind: null, assessmentHadEvent: null });
    expect(selectCachedBacklogStubs([evaluatedWithoutAi], versions)).toEqual([]);
  });

  it("rehydrates stale versions and assessments whose event payload was intentionally not cached", () => {
    const stale = row({ gmailMessageId: "stale", promptVersion: "prompt-v4" });
    const event = row({ gmailMessageId: "event", assessmentHadEvent: true });
    const archived = row({ gmailMessageId: "archived", labelSnapshot: [] });

    expect(selectCachedBacklogStubs([stale, event, archived], versions)).toEqual([
      { id: "stale", threadId: "t1" },
      { id: "event", threadId: "t1" }
    ]);
  });
});
