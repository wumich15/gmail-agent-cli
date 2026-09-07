import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, chmodSync, closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/state/database.js";
import { AccountsRepository } from "../../src/state/repositories/accounts.js";
import { RuleGroupsRepository } from "../../src/state/repositories/rule-groups.js";
import { MessagesRepository } from "../../src/state/repositories/messages.js";
import { LabelCandidatesRepository } from "../../src/state/repositories/label-candidates.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshDbPath(): string {
  dir = mkdtempSync(join(tmpdir(), "gmail-agent-test-"));
  return join(dir, "state.sqlite");
}

describe("openDatabase", () => {
  it("creates the schema and is idempotent to reopen", () => {
    const path = freshDbPath();
    const db1 = openDatabase(path);
    db1.close();
    const db2 = openDatabase(path);
    const tables = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("accounts");
    expect(tables).toContain("rule_groups");
    expect(tables).toContain("actions");
    db2.close();
  });

  it("refuses a pre-existing file that is group/world-readable", () => {
    if (process.platform === "win32") return; // POSIX-only permission model.
    const path = freshDbPath();
    closeSync(openSync(path, "w"));
    chmodSync(path, 0o644); // world-readable
    expect(() => openDatabase(path)).toThrow(/group\/world-accessible/);
  });

  it("round-trips an account record", () => {
    const db = openDatabase(freshDbPath());
    const repo = new AccountsRepository(db);
    repo.upsert({
      accountHash: "abc",
      emailDisplay: "me@example.com",
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z"
    });
    const found = repo.get("abc");
    expect(found?.emailDisplay).toBe("me@example.com");
    db.close();
  });

  it("round-trips a rule group with matchers", () => {
    const db = openDatabase(freshDbPath());
    new AccountsRepository(db).upsert({
      accountHash: "abc",
      emailDisplay: null,
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });
    const repo = new RuleGroupsRepository(db);
    repo.create({
      id: "r1",
      accountHash: "abc",
      categoryName: "LinkedIn",
      action: "spam",
      enabled: true,
      matchers: [{ kind: "from_address", normalizedValue: "x@example.com", authBinding: null }],
      createdAt: "now",
      updatedAt: "now"
    });
    const groups = repo.list("abc");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matchers).toHaveLength(1);
    db.close();
  });

  it("persists and reads back an account's history marker", () => {
    const db = openDatabase(freshDbPath());
    const repo = new AccountsRepository(db);
    repo.upsert({
      accountHash: "abc",
      emailDisplay: null,
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });
    repo.updateHistoryMarker("abc", "12345", "later");
    expect(repo.get("abc")?.historyMarker).toBe("12345");
    db.close();
  });

  it("round-trips a cached message record, including its label snapshot", () => {
    const db = openDatabase(freshDbPath());
    new AccountsRepository(db).upsert({
      accountHash: "abc",
      emailDisplay: null,
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });
    const repo = new MessagesRepository(db);
    repo.upsert({
      accountHash: "abc",
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      contentHash: "hash-1",
      labelSnapshot: ["INBOX", "UNREAD"],
      classifierVersion: null,
      promptVersion: null,
      schemaVersion: null,
      policyVersion: null,
      assessmentKind: null,
      assessmentConfidence: null,
      importanceScore: null,
      importanceConfidence: null,
      reasonCodes: null,
      processedAt: "now",
      subject: "Hello",
      senderDisplay: "alice@example.com",
      internalDate: "1000",
      category: null,
      assessmentHadEvent: true
    });
    const found = repo.get("abc", "m1");
    expect(found?.contentHash).toBe("hash-1");
    expect(found?.labelSnapshot).toEqual(["INBOX", "UNREAD"]);
    expect(found?.subject).toBe("Hello");
    expect(found?.senderDisplay).toBe("alice@example.com");
    expect(found?.assessmentHadEvent).toBe(true);
    expect(repo.countForAccount("abc")).toBe(1);
    db.close();
  });

  it("upserting a cached message record twice updates it in place rather than duplicating", () => {
    const db = openDatabase(freshDbPath());
    new AccountsRepository(db).upsert({
      accountHash: "abc",
      emailDisplay: null,
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });
    const repo = new MessagesRepository(db);
    const base = {
      accountHash: "abc",
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      labelSnapshot: ["INBOX"],
      classifierVersion: null,
      promptVersion: null,
      schemaVersion: null,
      policyVersion: null,
      assessmentKind: null,
      assessmentConfidence: null,
      importanceScore: null,
      importanceConfidence: null,
      reasonCodes: null,
      subject: "Hi",
      senderDisplay: "a@example.com",
      internalDate: "1000",
      category: null
    };
    repo.upsert({ ...base, contentHash: "hash-1", processedAt: "t0" });
    repo.upsert({ ...base, contentHash: "hash-2", processedAt: "t1" });
    expect(repo.countForAccount("abc")).toBe(1);
    expect(repo.get("abc", "m1")?.contentHash).toBe("hash-2");
    db.close();
  });

  it("listForAccount returns cached messages most-recent-first by internalDate", () => {
    const db = openDatabase(freshDbPath());
    new AccountsRepository(db).upsert({
      accountHash: "abc",
      emailDisplay: null,
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });
    const repo = new MessagesRepository(db);
    const base = {
      accountHash: "abc",
      gmailThreadId: "t1",
      contentHash: "hash",
      labelSnapshot: ["INBOX"],
      classifierVersion: null,
      promptVersion: null,
      schemaVersion: null,
      policyVersion: null,
      assessmentKind: null,
      assessmentConfidence: null,
      importanceScore: null,
      importanceConfidence: null,
      reasonCodes: null,
      processedAt: "now",
      senderDisplay: "a@example.com",
      category: null
    };
    repo.upsert({ ...base, gmailMessageId: "old", subject: "Old", internalDate: "1000" });
    repo.upsert({ ...base, gmailMessageId: "new", subject: "New", internalDate: "9000" });
    repo.upsert({ ...base, gmailMessageId: "mid", subject: "Mid", internalDate: "5000" });
    const list = repo.listForAccount("abc");
    expect(list.map((m) => m.gmailMessageId)).toEqual(["new", "mid", "old"]);
    db.close();
  });

  it("accumulates a label candidate's pending count across upserts and lists it back", () => {
    const db = openDatabase(freshDbPath());
    new AccountsRepository(db).upsert({
      accountHash: "abc",
      emailDisplay: null,
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });
    const repo = new LabelCandidatesRepository(db);
    repo.upsert({ accountHash: "abc", normalizedName: "shopping", displayName: "Shopping", pendingCount: 3, updatedAt: "t0" });
    repo.upsert({ accountHash: "abc", normalizedName: "shopping", displayName: "Shopping", pendingCount: 7, updatedAt: "t1" });
    const rows = repo.listForAccount("abc");
    expect(rows).toEqual([
      { accountHash: "abc", normalizedName: "shopping", displayName: "Shopping", pendingCount: 7, updatedAt: "t1" }
    ]);
    db.close();
  });

  it("removes a label candidate once cleared (the label was actually created)", () => {
    const db = openDatabase(freshDbPath());
    new AccountsRepository(db).upsert({
      accountHash: "abc",
      emailDisplay: null,
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });
    const repo = new LabelCandidatesRepository(db);
    repo.upsert({ accountHash: "abc", normalizedName: "shopping", displayName: "Shopping", pendingCount: 10, updatedAt: "now" });
    repo.clear("abc", "shopping");
    expect(repo.listForAccount("abc")).toEqual([]);
    db.close();
  });

  it("records and lists voted message IDs, deduplicated by (account, category)", () => {
    const db = openDatabase(freshDbPath());
    new AccountsRepository(db).upsert({
      accountHash: "abc",
      emailDisplay: null,
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });
    const repo = new LabelCandidatesRepository(db);
    repo.recordVotes("abc", "shopping", ["m1", "m2"]);
    // Recording the same message ID again (a later run reconciling the
    // same message) must not create a duplicate row or otherwise error.
    repo.recordVotes("abc", "shopping", ["m2", "m3"]);
    const voted = repo.listVotedMessageIdsForAccount("abc");
    expect(voted.get("shopping")).toEqual(new Set(["m1", "m2", "m3"]));
    db.close();
  });

  it("clear() also removes that category's voted-message-ID rows", () => {
    const db = openDatabase(freshDbPath());
    new AccountsRepository(db).upsert({
      accountHash: "abc",
      emailDisplay: null,
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });
    const repo = new LabelCandidatesRepository(db);
    repo.upsert({ accountHash: "abc", normalizedName: "shopping", displayName: "Shopping", pendingCount: 10, updatedAt: "now" });
    repo.recordVotes("abc", "shopping", ["m1"]);
    repo.clear("abc", "shopping");
    expect(repo.listVotedMessageIdsForAccount("abc").get("shopping")).toBeUndefined();
    db.close();
  });

  it("gmail uncache: clears every cached message record and label candidate for an account, and resets the history marker", () => {
    const db = openDatabase(freshDbPath());
    const accountsRepo = new AccountsRepository(db);
    accountsRepo.upsert({
      accountHash: "abc",
      emailDisplay: null,
      timezone: "UTC",
      historyMarker: "12345",
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });
    const messagesRepo = new MessagesRepository(db);
    messagesRepo.upsert({
      accountHash: "abc",
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      contentHash: "hash-1",
      labelSnapshot: ["INBOX"],
      classifierVersion: null,
      promptVersion: null,
      schemaVersion: null,
      policyVersion: null,
      assessmentKind: null,
      assessmentConfidence: null,
      importanceScore: null,
      importanceConfidence: null,
      reasonCodes: null,
      processedAt: "now",
      subject: "Hi",
      senderDisplay: "a@example.com",
      internalDate: "1000",
      category: null
    });
    const candidatesRepo = new LabelCandidatesRepository(db);
    candidatesRepo.upsert({ accountHash: "abc", normalizedName: "shopping", displayName: "Shopping", pendingCount: 3, updatedAt: "now" });
    candidatesRepo.recordVotes("abc", "shopping", ["m1"]);

    expect(messagesRepo.clearForAccount("abc")).toBe(1);
    expect(candidatesRepo.clearForAccount("abc")).toBe(1);
    accountsRepo.updateHistoryMarker("abc", null, "later");

    expect(messagesRepo.countForAccount("abc")).toBe(0);
    expect(candidatesRepo.listForAccount("abc")).toEqual([]);
    expect(candidatesRepo.listVotedMessageIdsForAccount("abc").size).toBe(0);
    expect(accountsRepo.get("abc")?.historyMarker).toBeNull();
    db.close();
  });
});
