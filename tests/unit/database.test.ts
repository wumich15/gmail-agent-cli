import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, chmodSync, closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/state/database.js";
import { AccountsRepository } from "../../src/state/repositories/accounts.js";
import { RuleGroupsRepository } from "../../src/state/repositories/rule-groups.js";

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
});
