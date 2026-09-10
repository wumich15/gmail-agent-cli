import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type GmailAgentDatabase } from "../../src/state/database.js";
import { loadSentThreadIndex } from "../../src/gmail/sent-index.js";
import type { GmailClient } from "../../src/gmail/client.js";

/**
 * Reply protection gates every AI-derived Trash action, so this index has
 * to be complete before the action phase can start. These tests pin the
 * property that made it worth persisting: the set stays correct while the
 * number of Gmail requests to obtain it collapses after the first run.
 */

const directories: string[] = [];

function freshDatabase(...accountHashes: string[]): GmailAgentDatabase {
  const directory = mkdtempSync(join(tmpdir(), "gmail-sent-index-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "state.sqlite"));
  for (const accountHash of accountHashes.length > 0 ? accountHashes : ["acct"]) {
    db.prepare(
      `INSERT INTO accounts (account_hash, email_display, timezone, history_marker, setup_complete,
                             automation_enabled, created_at, updated_at)
       VALUES (?, NULL, 'UTC', NULL, 1, 0, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`
    ).run(accountHash);
  }
  return db;
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function pagedClient(pages: Array<{ messages: Array<{ id: string; threadId: string }>; nextPageToken?: string }>) {
  const list = vi.fn(async (params: { pageToken?: string }) => {
    const index = params.pageToken ? Number(params.pageToken) : 0;
    return { data: pages[index] ?? { messages: [] } };
  });
  return { client: { users: { messages: { list } } } as unknown as GmailClient, list };
}

describe("sent thread index", () => {
  it("pays for a full pagination once, then only asks for newer mail", async () => {
    const db = freshDatabase();
    const { client, list } = pagedClient([
      { messages: [{ id: "s3", threadId: "t3" }, { id: "s2", threadId: "t2" }], nextPageToken: "1" },
      { messages: [{ id: "s1", threadId: "t1" }] }
    ]);

    const cold = await loadSentThreadIndex(db, "acct", client, "2026-09-09T00:00:00.000Z");
    expect(cold.coldStart).toBe(true);
    expect([...cold.threadIds].sort()).toEqual(["t1", "t2", "t3"]);
    expect(list).toHaveBeenCalledTimes(2);

    // A later run stops at the newest message it already recorded, so the
    // second page is never requested again.
    list.mockClear();
    const warm = await loadSentThreadIndex(db, "acct", client, "2026-09-09T00:05:00.000Z");
    expect(warm.coldStart).toBe(false);
    expect(warm.discovered).toBe(0);
    expect([...warm.threadIds].sort()).toEqual(["t1", "t2", "t3"]);
    expect(list).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("adds threads from newly sent mail without losing previously known ones", async () => {
    const db = freshDatabase();
    const first = pagedClient([{ messages: [{ id: "s1", threadId: "t1" }] }]);
    await loadSentThreadIndex(db, "acct", first.client, "2026-09-09T00:00:00.000Z");

    const second = pagedClient([{ messages: [{ id: "s2", threadId: "t2" }, { id: "s1", threadId: "t1" }] }]);
    const warm = await loadSentThreadIndex(db, "acct", second.client, "2026-09-09T00:05:00.000Z");

    expect(warm.discovered).toBe(1);
    expect([...warm.threadIds].sort()).toEqual(["t1", "t2"]);
    db.close();
  });

  it("keeps the index per-account", async () => {
    const db = freshDatabase("acct-a", "acct-b");
    const { client } = pagedClient([{ messages: [{ id: "s1", threadId: "t1" }] }]);
    await loadSentThreadIndex(db, "acct-a", client, "2026-09-09T00:00:00.000Z");
    const other = await loadSentThreadIndex(db, "acct-b", client, "2026-09-09T00:00:00.000Z");
    expect(other.coldStart).toBe(true);
    db.close();
  });
});
