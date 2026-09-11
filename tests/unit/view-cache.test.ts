import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type GmailAgentDatabase } from "../../src/state/database.js";
import { AccountsRepository } from "../../src/state/repositories/accounts.js";
import { MessagesRepository, type CachedMessageRecord } from "../../src/state/repositories/messages.js";
import { SETTING_KEYS, SettingsRepository } from "../../src/state/repositories/settings.js";
import {
  ProgressiveViewCache,
  ViewBackgroundLockBusyError,
  ViewOperationCoordinator
} from "../../src/gmail/view-cache.js";
import type { GmailClient } from "../../src/gmail/client.js";
import type { AccountRecord } from "../../src/core/models.js";
import { ProcessLock } from "../../src/core/lock.js";
import { SafetyPreconditionError } from "../../src/core/errors.js";

let directory: string;
let db: GmailAgentDatabase;
let account: AccountRecord;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "gmail-progressive-view-"));
  db = openDatabase(join(directory, "state.sqlite"));
  account = {
    accountHash: "account",
    emailDisplay: "me@example.com",
    timezone: "UTC",
    historyMarker: null,
    setupComplete: true,
    automationEnabled: false,
    createdAt: "earlier",
    updatedAt: "earlier"
  };
  new AccountsRepository(db).upsert(account);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function cached(id: string, labels: string[]): CachedMessageRecord {
  return {
    accountHash: "account",
    gmailMessageId: id,
    gmailThreadId: `thread-${id}`,
    contentHash: `hash-${id}`,
    labelSnapshot: labels,
    classifierVersion: null,
    promptVersion: null,
    schemaVersion: null,
    policyVersion: null,
    assessmentKind: null,
    assessmentConfidence: null,
    importanceScore: null,
    importanceConfidence: null,
    reasonCodes: null,
    processedAt: "earlier",
    subject: id,
    senderDisplay: "sender@example.com",
    internalDate: "1",
    category: null,
    assessmentHadEvent: null
  };
}

interface FakeMail {
  id: string;
  labels: string[];
}

function loaderClient(
  folders: Record<"inbox" | "archive" | "trash" | "spam", FakeMail[]>,
  failMessage?: string | ((messageId: string) => boolean),
  /** Simulated Gmail latency, so a background walk lasts long enough to observe. */
  latencyMs = 0
): { client: GmailClient; list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  const byId = new Map(Object.values(folders).flat().map((message) => [message.id, message]));
  const list = vi.fn(async (params: {
    labelIds?: string[];
    q?: string;
    pageToken?: string;
    maxResults: number;
  }) => {
    const folder = params.q === "in:archive"
      ? "archive"
      : params.labelIds?.includes("TRASH")
        ? "trash"
        : params.labelIds?.includes("SPAM")
          ? "spam"
          : "inbox";
    const source = folders[folder];
    const offset = params.pageToken ? Number(params.pageToken.split(":")[1]) : 0;
    const messages = source.slice(offset, offset + params.maxResults);
    const nextOffset = offset + messages.length;
    return {
      data: {
        messages: messages.map((message) => ({ id: message.id, threadId: `thread-${message.id}` })),
        ...(nextOffset < source.length ? { nextPageToken: `${folder}:${nextOffset}` } : {}),
        resultSizeEstimate: source.length
      }
    };
  });
  const get = vi.fn(async ({ id }: { id: string }) => {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    if (typeof failMessage === "function" ? failMessage(id) : id === failMessage) {
      throw Object.assign(new Error("read failed"), { status: 400 });
    }
    const message = byId.get(id)!;
    return {
      data: {
        id,
        threadId: `thread-${id}`,
        historyId: "100",
        internalDate: String(1000 + Number(id.replace(/\D/g, "") || 0)),
        labelIds: message.labels,
        snippet: `snippet ${id}`,
        payload: {
          mimeType: "text/plain",
          body: { data: Buffer.from(`body ${id}`).toString("base64url") },
          headers: [
            { name: "From", value: "Sender <sender@example.com>" },
            { name: "Subject", value: id }
          ]
        }
      }
    };
  });
  const client = {
    users: {
      getProfile: async () => ({ data: { emailAddress: "me@example.com", historyId: "100" } }),
      messages: { list, get }
    }
  } as unknown as GmailClient;
  return { client, list, get };
}

function fixtureFolders(): Record<"inbox" | "archive" | "trash" | "spam", FakeMail[]> {
  return {
    inbox: Array.from({ length: 8 }, (_, index) => ({ id: `inbox-${index}`, labels: ["INBOX"] })),
    archive: [{ id: "archive-1", labels: [] }, { id: "archive-2", labels: ["STARRED"] }],
    trash: [{ id: "trash-1", labels: ["TRASH"] }],
    spam: [{ id: "spam-1", labels: ["SPAM"] }]
  };
}

function createLoader(client: GmailClient): ProgressiveViewCache {
  return new ProgressiveViewCache({
    db,
    gmailClient: client,
    account,
    nowIso: () => "2026-09-11T12:00:00.000Z",
    pageSize: 2,
    runExclusive: async (operation) => operation(),
    backgroundPauseMs: 0
  });
}

describe("ProgressiveViewCache", () => {
  it("blocks only for the first three UI pages, fetched one page at a time, then completes in the background", async () => {
    new MessagesRepository(db).upsert(cached("stale", ["INBOX"]));
    const { client, list, get } = loaderClient(fixtureFolders());
    const loader = createLoader(client);

    const initial = await loader.ensureFolder("inbox", 6);

    expect(initial.cached).toBeGreaterThanOrEqual(6);
    expect(initial.listed).toBe(6);
    expect(get).toHaveBeenCalledTimes(6);
    // One UI page per Gmail round trip, not all three at once: each chunk
    // is one account-lock acquisition, and a long one locks every other
    // gmail command (and this session's own keystrokes) out for its whole
    // duration.
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ labelIds: ["INBOX"], maxResults: 2 });
    expect(new SettingsRepository(db).get("account", SETTING_KEYS.viewHistoryMarker)).toBeNull();

    await expect(loader.whenComplete()).resolves.toBe(true);
    expect(new MessagesRepository(db).listForAccount("account")).toHaveLength(12);
    expect(new MessagesRepository(db).get("account", "stale")).toBeNull();
    expect(new SettingsRepository(db).get("account", SETTING_KEYS.viewHistoryMarker)).toBe("100");
    expect(new SettingsRepository(db).get("account", SETTING_KEYS.viewFullCacheAt)).toBe(
      "2026-09-11T12:00:00.000Z"
    );
    expect(new AccountsRepository(db).get("account")?.historyMarker).toBe("100");
  });

  it("raises foreground demand beyond the initial horizon without duplicating earlier IDs", async () => {
    const { client, get } = loaderClient(fixtureFolders());
    const loader = createLoader(client);

    await loader.ensureFolder("inbox", 6);
    await loader.ensureFolder("inbox", 8);

    expect(loader.status("inbox")).toMatchObject({ listed: 8, cached: 8, complete: true });
    expect(get.mock.calls.map(([params]) => (params as { id: string }).id)).toEqual([
      "inbox-0",
      "inbox-1",
      "inbox-2",
      "inbox-3",
      "inbox-4",
      "inbox-5",
      "inbox-6",
      "inbox-7"
    ]);
    await loader.stop();
  });

  it("opens from an existing partial cache without blocking on duplicate remote reads", async () => {
    const messages = new MessagesRepository(db);
    for (let index = 0; index < 6; index += 1) {
      messages.upsert(cached(`inbox-${index}`, ["INBOX"]));
    }
    const { client, list, get } = loaderClient(fixtureFolders());
    const loader = createLoader(client);

    const initial = await loader.ensureFolder("inbox", 6);

    expect(initial.cached).toBe(6);
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    await loader.stop();
  });

  it("uses a normal chunk when an almost-full cache needs one more row", async () => {
    const messages = new MessagesRepository(db);
    for (let index = 0; index < 5; index += 1) {
      messages.upsert(cached(`inbox-${index}`, ["INBOX"]));
    }
    const { client, list } = loaderClient(fixtureFolders());
    const loader = createLoader(client);

    const initial = await loader.ensureFolder("inbox", 6);

    // The five cached rows are re-listed before the sixth is reached, so
    // the read budget has to cover the whole target, not just the gap.
    expect(initial.cached).toBe(6);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ maxResults: 2 });
    await loader.stop();
  });

  it("bounds a foreground load even when every hydration in its three-page horizon fails", async () => {
    const { client, list, get } = loaderClient(fixtureFolders(), () => true);
    const loader = createLoader(client);

    const initial = await loader.ensureFolder("inbox", 6);

    expect(initial).toMatchObject({ cached: 0, listed: 6, failed: 6 });
    expect(list).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledTimes(6);
    await loader.stop();
  });

  it("does not prune a row that a foreground view action changed during the full scan", async () => {
    const messages = new MessagesRepository(db);
    messages.upsert(cached("moved-during-scan", ["UNREAD"]));
    const { client } = loaderClient(fixtureFolders());
    const loader = createLoader(client);

    await loader.ensureFolder("inbox", 6);
    messages.upsert(cached("moved-during-scan", ["INBOX", "UNREAD"]));
    loader.retainId("moved-during-scan");
    await expect(loader.whenComplete()).resolves.toBe(true);

    expect(new MessagesRepository(db).get("account", "moved-during-scan")?.labelSnapshot).toEqual([
      "INBOX",
      "UNREAD"
    ]);
  });

  it("preserves a cross-session projection written after the snapshot began", async () => {
    const { client } = loaderClient(fixtureFolders());
    const loader = createLoader(client);

    await loader.ensureFolder("inbox", 6);
    new MessagesRepository(db).upsert({
      ...cached("restored-by-another-view", ["INBOX", "UNREAD"]),
      processedAt: "2026-09-11T12:00:01.000Z"
    });
    await expect(loader.whenComplete()).resolves.toBe(true);

    expect(new MessagesRepository(db).get("account", "restored-by-another-view")?.labelSnapshot).toEqual([
      "INBOX",
      "UNREAD"
    ]);
  });

  it("does not let an older completing snapshot prune or regress a newer view fence", async () => {
    const messages = new MessagesRepository(db);
    messages.upsert(cached("newer-snapshot-row", ["TRASH"]));
    const { client } = loaderClient(fixtureFolders());
    const loader = createLoader(client);

    await loader.ensureFolder("inbox", 6);
    const settings = new SettingsRepository(db);
    settings.set("account", SETTING_KEYS.viewHistoryMarker, "200", "2026-09-11T12:00:01.000Z");
    settings.set("account", SETTING_KEYS.viewFullCacheAt, "2026-09-11T12:00:01.000Z", "2026-09-11T12:00:01.000Z");
    await expect(loader.whenComplete()).resolves.toBe(true);

    expect(messages.get("account", "newer-snapshot-row")).not.toBeNull();
    expect(settings.get("account", SETTING_KEYS.viewHistoryMarker)).toBe("200");
    expect(settings.get("account", SETTING_KEYS.viewFullCacheAt)).toBe("2026-09-11T12:00:01.000Z");
  });

  it("retries background loading after yielding to a contended account lock", async () => {
    const lockPath = join(directory, "retry-account.lock");
    const external = new ProcessLock(lockPath);
    external.acquire();
    try {
      const { client, list } = loaderClient(fixtureFolders());
      const coordinator = new ViewOperationCoordinator(lockPath);
      const loader = new ProgressiveViewCache({
        db,
        gmailClient: client,
        account,
        nowIso: () => "2026-09-11T12:00:00.000Z",
        pageSize: 2,
        runExclusive: coordinator.runExclusive
      });
      const initial = loader.ensureFolder("inbox", 6);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(list).not.toHaveBeenCalled();

      await expect(coordinator.runExclusive(async () => undefined)).rejects.toBeInstanceOf(
        SafetyPreconditionError
      );
      external.release();

      await expect(initial).resolves.toMatchObject({ cached: 6, listed: 6 });
      await loader.stop();
    } finally {
      external.release();
    }
  });

  it("gives up waiting on a contended lock instead of hanging the interface forever", async () => {
    // Regression: the contended-lock retry loop was unbounded and never
    // woke the waiter, so `gmail view`'s startup — which awaits the first
    // chunk — produced no list, no prompt and no error at all whenever
    // another gmail process held the account lock. Indistinguishable from
    // a crash, and the viewer's own background loader was usually the
    // process holding it.
    const lockPath = join(directory, "contended-account.lock");
    const external = new ProcessLock(lockPath);
    external.acquire();
    try {
      const { client, list } = loaderClient(fixtureFolders());
      const coordinator = new ViewOperationCoordinator(lockPath);
      const loader = new ProgressiveViewCache({
        db,
        gmailClient: client,
        account,
        nowIso: () => "2026-09-11T12:00:00.000Z",
        pageSize: 2,
        runExclusive: coordinator.runExclusive,
        backgroundPauseMs: 0
      });

      const status = await loader.ensureFolder("inbox", 6, { timeoutMs: 150 });

      expect(list).not.toHaveBeenCalled();
      expect(status).toMatchObject({ folder: "inbox", cached: 0 });
      expect(loader.waitingForAccountLock).toBe(true);
      await loader.stop();
    } finally {
      external.release();
    }
  });

  it("stands aside between background chunks so another process can take the lock", async () => {
    // Regression: the pump started the next chunk the instant the previous
    // one committed, and each chunk holds the cross-process account lock
    // for its whole list-plus-hydrate span. The lock file therefore existed
    // essentially continuously for as long as a view session was open, and
    // every other gmail command died with "another gmail process is already
    // running". Sampling how often the lock file is absent during a
    // sustained walk measures exactly that: whether there is any window at
    // all for another process to get in.
    const lockPath = join(directory, "shared-account.lock");
    const busyFolders = {
      ...fixtureFolders(),
      inbox: Array.from({ length: 400 }, (_, index) => ({ id: `inbox-${index}`, labels: ["INBOX"] }))
    };
    const { client } = loaderClient(busyFolders, undefined, 20);
    const coordinator = new ViewOperationCoordinator(lockPath);
    const loader = new ProgressiveViewCache({
      db,
      gmailClient: client,
      account,
      nowIso: () => "2026-09-11T12:00:00.000Z",
      pageSize: 2,
      runExclusive: coordinator.runExclusive,
      backgroundPauseMs: 60
    });

    loader.startBackground();
    try {
      while (loader.status("inbox").listed < 4) await new Promise((resolve) => setTimeout(resolve, 5));

      let samples = 0;
      let lockFree = 0;
      const sampler = setInterval(() => {
        samples += 1;
        if (!existsSync(lockPath)) lockFree += 1;
      }, 2);
      await new Promise((resolve) => setTimeout(resolve, 500));
      clearInterval(sampler);

      expect(samples).toBeGreaterThan(20);
      // Still mid-walk: the lock has to be free *during* the load, not
      // merely once it finishes.
      expect(loader.status("inbox").complete).toBe(false);
      expect(lockFree / samples).toBeGreaterThan(0.2);
    } finally {
      await loader.stop();
    }
  });

  it("keeps partial rows and earns no fence when one hydration fails", async () => {
    new MessagesRepository(db).upsert(cached("old", ["TRASH"]));
    const { client } = loaderClient(fixtureFolders(), "inbox-2");
    const loader = createLoader(client);

    await loader.ensureFolder("inbox", 6);
    await expect(loader.whenComplete()).resolves.toBe(false);

    expect(new MessagesRepository(db).get("account", "inbox-1")).not.toBeNull();
    expect(new MessagesRepository(db).get("account", "old")).not.toBeNull();
    expect(new SettingsRepository(db).get("account", SETTING_KEYS.viewHistoryMarker)).toBeNull();
    expect(new AccountsRepository(db).get("account")?.historyMarker).toBeNull();
  });
});

describe("ViewOperationCoordinator", () => {
  it("serializes a foreground mutation behind an in-flight background chunk", async () => {
    const coordinator = new ViewOperationCoordinator(join(directory, "account.lock"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];

    const background = coordinator.runExclusive(async () => {
      events.push("background-start");
      await gate;
      events.push("background-commit");
    });
    const foreground = coordinator.runExclusive(async () => {
      events.push("foreground-mutation");
    });
    await Promise.resolve();
    expect(events).toEqual(["background-start"]);

    release();
    await Promise.all([background, foreground]);
    expect(events).toEqual(["background-start", "background-commit", "foreground-mutation"]);
  });

  it("releases the session queue when cancellable background work finds a contended lock", async () => {
    const lockPath = join(directory, "account.lock");
    const external = new ProcessLock(lockPath);
    external.acquire();
    try {
      const coordinator = new ViewOperationCoordinator(lockPath);
      const operation = vi.fn(async () => undefined);
      const controller = new AbortController();
      const pending = coordinator.runExclusive(operation, controller.signal);
      await expect(pending).rejects.toBeInstanceOf(ViewBackgroundLockBusyError);
      expect(operation).not.toHaveBeenCalled();

      const foreground = vi.fn(async () => undefined);
      await expect(coordinator.runExclusive(foreground)).rejects.toBeInstanceOf(
        SafetyPreconditionError
      );
      expect(foreground).not.toHaveBeenCalled();
    } finally {
      external.release();
    }
  });
});
