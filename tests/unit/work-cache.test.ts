import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestCacheRefreshAt, selectCachedBacklogStubs, type CurrentCacheVersions } from "../../src/commands/work.js";
import { openDatabase, type GmailAgentDatabase } from "../../src/state/database.js";
import { SETTING_KEYS, SettingsRepository } from "../../src/state/repositories/settings.js";
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

describe("latestCacheRefreshAt", () => {
  const directories: string[] = [];

  function freshDatabase(): GmailAgentDatabase {
    const directory = mkdtempSync(join(tmpdir(), "gmail-work-cache-"));
    directories.push(directory);
    const db = openDatabase(join(directory, "state.sqlite"));
    db.prepare(
      `INSERT INTO accounts (account_hash, email_display, timezone, history_marker, setup_complete,
                             automation_enabled, created_at, updated_at)
       VALUES ('acct', NULL, 'UTC', NULL, 1, 0, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`
    ).run();
    return db;
  }

  afterEach(() => {
    while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
  });

  it("reports nothing when the cache has never been refreshed", () => {
    const db = freshDatabase();
    expect(latestCacheRefreshAt(db, "acct")).toBeNull();
    db.close();
  });

  it("prefers a view session's refresh over an older gmail cache run, and vice versa", () => {
    const db = freshDatabase();
    const settings = new SettingsRepository(db);

    // A view session that has been syncing itself is the more recent truth
    // about staleness, even though `gmail cache` owns the other timestamp.
    settings.set("acct", SETTING_KEYS.cacheLastRunAt, "2026-09-09T01:00:00.000Z", "now");
    settings.set("acct", SETTING_KEYS.viewLastRefreshAt, "2026-09-09T03:00:00.000Z", "now");
    expect(latestCacheRefreshAt(db, "acct")).toBe("2026-09-09T03:00:00.000Z");

    settings.set("acct", SETTING_KEYS.cacheLastRunAt, "2026-09-09T04:00:00.000Z", "now");
    expect(latestCacheRefreshAt(db, "acct")).toBe("2026-09-09T04:00:00.000Z");
    db.close();
  });

  it("uses whichever single timestamp exists", () => {
    const db = freshDatabase();
    new SettingsRepository(db).set("acct", SETTING_KEYS.viewLastRefreshAt, "2026-09-09T02:00:00.000Z", "now");
    expect(latestCacheRefreshAt(db, "acct")).toBe("2026-09-09T02:00:00.000Z");
    db.close();
  });
});
