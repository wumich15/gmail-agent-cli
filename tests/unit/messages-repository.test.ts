import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type GmailAgentDatabase } from "../../src/state/database.js";
import { AccountsRepository } from "../../src/state/repositories/accounts.js";
import { MessagesRepository, type CachedMessageRecord } from "../../src/state/repositories/messages.js";

let directory: string;
let db: GmailAgentDatabase;
let repository: MessagesRepository;

function row(id: string): CachedMessageRecord {
  return {
    accountHash: "account", gmailMessageId: id, gmailThreadId: `thread-${id}`,
    contentHash: "hash", labelSnapshot: ["UNREAD", "INBOX"], classifierVersion: null,
    promptVersion: null, schemaVersion: null, policyVersion: null, assessmentKind: null,
    assessmentConfidence: null, importanceScore: null, importanceConfidence: null,
    reasonCodes: null, processedAt: "now", subject: "Subject", senderDisplay: "sender@example.com",
    internalDate: "1000", category: null, assessmentHadEvent: null
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "gmail-cache-repository-"));
  db = openDatabase(join(directory, "state.sqlite"));
  new AccountsRepository(db).upsert({
    accountHash: "account", emailDisplay: null, timezone: "UTC", historyMarker: null,
    setupComplete: true, automationEnabled: false, createdAt: "now", updatedAt: "now"
  });
  repository = new MessagesRepository(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("MessagesRepository cache batches", () => {
  it("writes 500 projections with reusable statements and deletes within the same commit", () => {
    repository.upsert(row("removed"));
    const prepare = vi.spyOn(db, "prepare");
    repository.applyCacheBatch("account", Array.from({ length: 500 }, (_, i) => row(`m${i}`)), ["removed"]);
    expect(repository.get("account", "m499")?.labelSnapshot).toEqual(["INBOX", "UNREAD"]);
    expect(repository.get("account", "removed")).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(repository.countForAccount("account")).toBe(500);
  });

  it("rolls a failed batch back without partially replacing the cache", () => {
    repository.upsert(row("keep"));
    expect(() => repository.applyCacheBatch("account", [row("first"), { ...row("bad"), accountHash: "other" }], ["keep"])).toThrow("multiple accounts");
    expect(repository.get("account", "first")).toBeNull();
    expect(repository.get("account", "keep")).not.toBeNull();
  });
});
