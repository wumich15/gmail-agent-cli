import { describe, expect, it, vi, afterEach } from "vitest";
import type { CachedMessageRecord } from "../../src/state/repositories/messages.js";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const {
  adjustPageSize,
  filterMessages,
  parseCleanupCommand,
  summarizeBulk,
  applyToTargets,
  setCachedStar,
  shortenLinksForDisplay,
  terminalHyperlink,
  openUrlInBrowser,
  trashCached,
  moveCachedToInbox
} = await import("../../src/commands/view.js");

function row(id: string, labels: string[], subject: string, sender: string): CachedMessageRecord {
  return {
    accountHash: "account", gmailMessageId: id, gmailThreadId: `thread-${id}`, contentHash: "hash",
    labelSnapshot: labels, classifierVersion: null, promptVersion: null, schemaVersion: null, policyVersion: null,
    assessmentKind: null, assessmentConfidence: null, importanceScore: null, importanceConfidence: null,
    reasonCodes: null, processedAt: "now", subject, senderDisplay: sender, internalDate: "1000", category: null,
    assessmentHadEvent: null
  };
}

describe("gmail view filtering", () => {
  const messages = [
    row("inbox", ["INBOX", "UNREAD"], "Project status", "Alice"),
    row("spam", ["SPAM", "UNREAD"], "Big sale", "Store"),
    row("starred", ["INBOX", "STARRED"], "Dinner", "Bob")
  ];

  it("defaults cleanly to a label view without hiding mail that has additional labels", () => {
    expect(filterMessages(messages, new Set(["INBOX"]), "").map((message) => message.gmailMessageId)).toEqual([
      "inbox", "starred"
    ]);
  });

  it("matches any selected label and combines it with local subject/sender search", () => {
    expect(filterMessages(messages, new Set(["UNREAD", "STARRED"]), "bob").map((message) => message.gmailMessageId)).toEqual([
      "starred"
    ]);
  });

  it("uses an empty label selection as all cached mail", () => {
    expect(filterMessages(messages, new Set(), "sale").map((message) => message.gmailMessageId)).toEqual(["spam"]);
  });
});

describe("terminalHyperlink", () => {
  const originalIsTTY = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  it("wraps the label in an OSC 8 hyperlink escape sequence on a TTY", () => {
    process.stdout.isTTY = true;
    const result = terminalHyperlink("[1]", "https://example.com");
    expect(result).toBe("\x1b]8;;https://example.com\x1b\\[1]\x1b]8;;\x1b\\");
  });

  it("returns the plain label with no escape codes when stdout is not a TTY (redirected output)", () => {
    process.stdout.isTTY = false;
    expect(terminalHyperlink("[1]", "https://example.com")).toBe("[1]");
  });
});

describe("shortenLinksForDisplay", () => {
  const originalIsTTY = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  it("replaces each distinct URL with a numbered label and returns the link table", () => {
    process.stdout.isTTY = false; // isolate from OSC 8 escape codes for this assertion
    const { text, links } = shortenLinksForDisplay("Click here (https://example.com/a) or here (https://example.com/b)");
    expect(text).not.toContain("https://example.com/a");
    expect(text).not.toContain("https://example.com/b");
    expect(links).toEqual([
      { label: "[1]", url: "https://example.com/a" },
      { label: "[2]", url: "https://example.com/b" }
    ]);
  });

  it("reuses the same label when the same URL appears more than once", () => {
    process.stdout.isTTY = false;
    const { links } = shortenLinksForDisplay("See https://example.com/a and again https://example.com/a");
    expect(links).toEqual([{ label: "[1]", url: "https://example.com/a" }]);
  });

  it("returns no links for plain text with no URLs", () => {
    const { text, links } = shortenLinksForDisplay("Just plain text, no links here.");
    expect(text).toBe("Just plain text, no links here.");
    expect(links).toEqual([]);
  });

  it("stops the address at the delimiters around it instead of opening a broken link", () => {
    // Regression: a Discord invite written as "<https://discord.gg/abc>*"
    // captured the closing bracket and the stray emphasis character, so both
    // the OSC 8 hyperlink and "o" handed the browser an address that does
    // not exist. Angle brackets reach the reader both from plain-text mail
    // and from decoded &lt;/&gt; in HTML mail.
    process.stdout.isTTY = false;
    expect(shortenLinksForDisplay("Join <https://discord.gg/abc>*").links).toEqual([
      { label: "[1]", url: "https://discord.gg/abc" }
    ]);
    expect(shortenLinksForDisplay("Join https://discord.gg/abc.").links).toEqual([
      { label: "[1]", url: "https://discord.gg/abc" }
    ]);
    expect(shortenLinksForDisplay("See https://example.com/a, then https://example.com/b!").links).toEqual([
      { label: "[1]", url: "https://example.com/a" },
      { label: "[2]", url: "https://example.com/b" }
    ]);
  });

  it("keeps the trailing punctuation in the sentence rather than deleting it with the link", () => {
    process.stdout.isTTY = false;
    expect(shortenLinksForDisplay("Join <https://discord.gg/abc>* now").text).toBe("Join <[1]>* now");
  });

  it("does not trim characters that carry meaning inside a URL", () => {
    process.stdout.isTTY = false;
    for (const url of [
      "https://example.com/path_to/x",
      "https://example.com/?q=a*b&n=1",
      "https://example.com/wiki/Foo_(bar)#s1"
    ]) {
      const { links } = shortenLinksForDisplay(`Open ${url} here`);
      expect(links[0]?.url, url).toBe(url);
    }
  });
});

describe("openUrlInBrowser", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    spawnMock.mockClear();
  });

  it("launches the platform's default browser command with the URL", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    openUrlInBrowser("https://example.com/a");
    expect(spawnMock).toHaveBeenCalledWith("open", ["https://example.com/a"], expect.any(Object));
  });

  it("never routes a URL through cmd.exe on Windows", () => {
    // Regression: the Windows path was `cmd /c start "" <url>`. Passing an
    // argument array is not protection there — Node only sets
    // windowsVerbatimArguments for shell:true, so libuv quotes each argument
    // itself, and it quotes only arguments containing a space, tab, or double
    // quote. Every other cmd.exe metacharacter, `&` included, reached the
    // interpreter raw. That truncated ordinary URLs (a Google consent URL is
    // nothing but &-joined parameters) and, since gmail view's "o" launches a
    // URL taken from an untrusted email body, turned a crafted link into
    // command execution.
    Object.defineProperty(process, "platform", { value: "win32" });
    openUrlInBrowser("https://example.com/?a=1&calc");
    const [command, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(command).not.toMatch(/cmd/i);
    expect(args.join(" ")).not.toMatch(/\bstart\b/);
    expect(args).toContain("https://example.com/?a=1&calc");
  });

  it("refuses a non-http(s) scheme instead of ever reaching a shell launcher", () => {
    openUrlInBrowser("javascript:alert(1)");
    openUrlInBrowser("file:///etc/passwd");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("gmail view page sizing", () => {
  it("moves through convenient page-size steps", () => {
    expect(adjustPageSize(5, "larger")).toBe(10);
    expect(adjustPageSize(20, "larger")).toBe(50);
    expect(adjustPageSize(17, "larger")).toBe(20);
    expect(adjustPageSize(17, "smaller")).toBe(10);
  });

  it("stays within the interactive bounds", () => {
    expect(adjustPageSize(1, "smaller")).toBe(1);
    expect(adjustPageSize(500, "larger")).toBe(500);
    expect(adjustPageSize(800, "larger")).toBe(800);
  });
});


describe("unprompted delete (\"dd\")", () => {
  function harness(trashImpl: () => Promise<unknown> = () => Promise.resolve({})) {
    const trash = vi.fn(trashImpl);
    const del = vi.fn();
    const batchDelete = vi.fn();
    const client = { users: { messages: { trash, delete: del, batchDelete } } };
    const repo = { upsert: vi.fn(), delete: vi.fn() };
    return { client, repo, trash };
  }

  it("moves the cached projection to Trash and returns the prior record that makes \";u\" work", async () => {
    const { client, repo, trash } = harness();
    const message = { ...assessedRow("m1", ["INBOX", "STARRED"]), processedAt: "before" };

    // No prompt module is involved at all: this path asks nothing.
    const result = await trashCached(client as never, repo as never, message, "after");

    expect(result).toEqual({ ok: true, record: message });
    expect(trash).toHaveBeenCalledWith({ userId: "me", id: "m1" }, expect.anything());
    expect(repo.delete).not.toHaveBeenCalled();
    expect(repo.upsert).toHaveBeenCalledOnce();
    expect(repo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      gmailMessageId: "m1",
      labelSnapshot: ["STARRED", "TRASH"],
      classifierVersion: null,
      assessmentKind: null,
      category: null,
      assessmentHadEvent: null,
      processedAt: "after"
    }));
  });

  it("never reaches a permanent-delete endpoint", async () => {
    const { client, repo } = harness();
    await trashCached(client as never, repo as never, row("m1", ["INBOX"], "Junk", "Store"));
    expect(client.users.messages.delete).not.toHaveBeenCalled();
    expect(client.users.messages.batchDelete).not.toHaveBeenCalled();
  });

  it("does nothing when the message is already in Trash", async () => {
    const { client, repo, trash } = harness();

    const result = await trashCached(
      client as never,
      repo as never,
      row("m1", ["TRASH", "INBOX"], "Junk", "Store")
    );

    expect(result).toEqual({ ok: false, message: "Already in Trash; permanent deletion is never supported." });
    expect(trash).not.toHaveBeenCalled();
    expect(client.users.messages.delete).not.toHaveBeenCalled();
    expect(client.users.messages.batchDelete).not.toHaveBeenCalled();
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("records no undo and keeps the cached row when Gmail rejects the delete", async () => {
    const { client, repo } = harness(() => Promise.reject(new Error("permission denied")));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await trashCached(client as never, repo as never, row("m1", ["INBOX"], "Junk", "Store"));

    expect(result.ok).toBe(false);
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
    // The failure is returned, not printed: "dd" clears the screen on its
    // next render, so a printed error would vanish and the message would
    // look deleted when it is still in the mailbox.
    expect(errors).not.toHaveBeenCalled();
    expect(result.ok ? "" : result.message).toContain("permission denied");
  });
});

function assessedRow(id: string, labels: string[]): CachedMessageRecord {
  return {
    ...row(id, labels, "Important message", "Sender"),
    classifierVersion: "classifier-v1",
    promptVersion: "prompt-v1",
    schemaVersion: "schema-v1",
    policyVersion: "policy-v1",
    assessmentKind: "personal_important",
    assessmentConfidence: 0.91,
    importanceScore: 87,
    importanceConfidence: 0.88,
    reasonCodes: ["direct_request"],
    category: "Work",
    assessmentHadEvent: true,
    processedAt: "before"
  };
}

function expectInvalidated(record: CachedMessageRecord, labelSnapshot: readonly string[]): void {
  expect(record).toEqual(expect.objectContaining({
    labelSnapshot,
    classifierVersion: null,
    promptVersion: null,
    schemaVersion: null,
    policyVersion: null,
    assessmentKind: null,
    assessmentConfidence: null,
    importanceScore: null,
    importanceConfidence: null,
    reasonCodes: null,
    category: null,
    assessmentHadEvent: null,
    processedAt: "after"
  }));
}

describe("star (\"s\")", () => {
  function harness(modifyImpl: () => Promise<unknown> = () => Promise.resolve({})) {
    const modify = vi.fn(modifyImpl);
    const client = { users: { messages: { modify } } };
    const repo = { upsert: vi.fn(), delete: vi.fn() };
    return { client, repo, modify };
  }

  it("adds STARRED and invalidates the cached assessment, since the label snapshot is a policy input", async () => {
    const { client, repo, modify } = harness();

    const result = await setCachedStar(client as never, repo as never, assessedRow("m1", ["INBOX"]), true, "after");

    expect(result.ok).toBe(true);
    expect(modify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "me", id: "m1", requestBody: { addLabelIds: ["STARRED"] } }),
      expect.anything()
    );
    expectInvalidated(repo.upsert.mock.calls[0]![0] as CachedMessageRecord, ["INBOX", "STARRED"]);
  });

  it("removes STARRED when unstarring", async () => {
    const { client, repo, modify } = harness();

    await setCachedStar(client as never, repo as never, assessedRow("m1", ["INBOX", "STARRED"]), false, "after");

    expect(modify).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: { removeLabelIds: ["STARRED"] } }),
      expect.anything()
    );
    expectInvalidated(repo.upsert.mock.calls[0]![0] as CachedMessageRecord, ["INBOX"]);
  });

  it("never adds IMPORTANT: a user starring a row asked for a star, not a classification", async () => {
    const { client, repo } = harness();
    await setCachedStar(client as never, repo as never, row("m1", ["INBOX"], "Subject", "Sender"), true, "after");
    const record = repo.upsert.mock.calls[0]![0] as CachedMessageRecord;
    expect(record.labelSnapshot).not.toContain("IMPORTANT");
  });

  it("calls Gmail at all only when the label would actually change", async () => {
    const { client, repo, modify } = harness();
    const starred = row("m1", ["INBOX", "STARRED"], "Subject", "Sender");

    const result = await setCachedStar(client as never, repo as never, starred, true, "after");

    expect(result).toEqual({ ok: true, record: starred });
    expect(modify).not.toHaveBeenCalled();
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("leaves the cached row untouched when Gmail rejects the change", async () => {
    const { client, repo } = harness(() => Promise.reject(new Error("permission denied")));

    const result = await setCachedStar(client as never, repo as never, row("m1", ["INBOX"], "S", "X"), true, "after");

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("permission denied");
    expect(repo.upsert).not.toHaveBeenCalled();
  });
});

describe("applying a row action across a selection", () => {
  const first = row("m1", ["INBOX"], "First", "A");
  const second = row("m2", ["INBOX"], "Second", "B");
  const third = row("m3", ["INBOX"], "Third", "C");

  it("keeps going after an isolated failure and reports both sides", async () => {
    const outcome = await applyToTargets([first, second, third], async (target) =>
      target.gmailMessageId === "m2"
        ? { ok: false, message: "Could not star: quota exceeded" }
        : { ok: true, record: target }
    );

    expect(outcome.done).toEqual([first, third]);
    expect(outcome.failures).toEqual(["Could not star: quota exceeded"]);
  });

  it("names a single message but counts several, and never hides a failure", () => {
    const one = (record: CachedMessageRecord): string => `Moved "${record.subject}" to Trash.`;
    const many = (count: number): string => `Moved ${count} messages to Trash.`;

    expect(summarizeBulk({ done: [first], failures: [] }, one, many)).toBe('Moved "First" to Trash.');
    expect(summarizeBulk({ done: [first, second], failures: [] }, one, many)).toBe("Moved 2 messages to Trash.");
    expect(summarizeBulk({ done: [first], failures: ["Could not move to Trash: nope"] }, one, many)).toBe(
      'Moved "First" to Trash. Could not move to Trash: nope'
    );
    expect(summarizeBulk({ done: [], failures: ["a", "b"] }, one, many)).toBe("2 failed; first: a");
    expect(summarizeBulk({ done: [], failures: [] }, one, many)).toBeNull();
  });

  it("appends the caller's extra note, such as rows that were already in Trash", () => {
    expect(
      summarizeBulk({ done: [first], failures: [] }, () => "Moved it.", (count) => `Moved ${count}.`, "1 already in Trash.")
    ).toBe("Moved it. 1 already in Trash.");
  });
});

describe("move cached message to Inbox", () => {
  function harness(overrides: {
    modify?: (() => Promise<unknown>) | undefined;
    untrash?: (() => Promise<unknown>) | undefined;
  } = {}) {
    const modify = vi.fn(overrides.modify ?? (() => Promise.resolve({})));
    const untrash = vi.fn(overrides.untrash ?? (() => Promise.resolve({})));
    const client = { users: { messages: { modify, untrash } } };
    const repo = { upsert: vi.fn() };
    return { client, repo, modify, untrash };
  }

  it("adds Inbox to archived mail and invalidates its cached assessment", async () => {
    const { client, repo, modify, untrash } = harness();
    const cached = assessedRow("archive", ["UNREAD", "STARRED"]);

    const outcome = await moveCachedToInbox(client as never, repo as never, cached, "after");

    if (!outcome.ok) throw new Error(outcome.message);
    expect(modify).toHaveBeenCalledWith({
      userId: "me",
      id: "archive",
      requestBody: { addLabelIds: ["INBOX"] }
    }, expect.anything());
    expect(untrash).not.toHaveBeenCalled();
    expectInvalidated(outcome.record, ["UNREAD", "STARRED", "INBOX"]);
    expect(repo.upsert).toHaveBeenCalledWith(outcome.record);
  });

  it("moves Spam to Inbox while explicitly removing the Spam label", async () => {
    const { client, repo, modify, untrash } = harness();
    const cached = assessedRow("spam", ["SPAM", "UNREAD", "Label_1"]);

    const outcome = await moveCachedToInbox(client as never, repo as never, cached, "after");

    if (!outcome.ok) throw new Error(outcome.message);
    expect(modify).toHaveBeenCalledWith({
      userId: "me",
      id: "spam",
      requestBody: { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] }
    }, expect.anything());
    expect(untrash).not.toHaveBeenCalled();
    expectInvalidated(outcome.record, ["UNREAD", "Label_1", "INBOX"]);
    expect(repo.upsert).toHaveBeenCalledWith(outcome.record);
  });

  it("untrashes Trash mail before adding Inbox and never re-adds Trash", async () => {
    const { client, repo, modify, untrash } = harness();
    const cached = assessedRow("trash", ["TRASH", "UNREAD", "Label_1"]);

    const outcome = await moveCachedToInbox(client as never, repo as never, cached, "after");

    if (!outcome.ok) throw new Error(outcome.message);
    expect(untrash).toHaveBeenCalledWith({ userId: "me", id: "trash" }, expect.anything());
    expect(modify).toHaveBeenCalledWith({
      userId: "me",
      id: "trash",
      requestBody: { addLabelIds: ["INBOX"] }
    }, expect.anything());
    expect(modify.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ addLabelIds: expect.arrayContaining(["TRASH"]) }));
    expectInvalidated(outcome.record, ["UNREAD", "Label_1", "INBOX"]);
    expect(outcome.record.labelSnapshot).not.toContain("TRASH");
    expect(repo.upsert).toHaveBeenCalledWith(outcome.record);
  });

  it("keeps the cache out of Trash when untrash succeeds but adding Inbox fails", async () => {
    const { client, repo, modify, untrash } = harness({
      modify: () => Promise.reject(new Error("modify failed"))
    });
    const cached = assessedRow("partial", ["TRASH", "UNREAD", "Label_1"]);

    const outcome = await moveCachedToInbox(client as never, repo as never, cached, "after");

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.message).toContain("Restored from Trash");
    expect(untrash).toHaveBeenCalledOnce();
    expect(modify).toHaveBeenCalledOnce();
    expect(repo.upsert).toHaveBeenCalledOnce();
    expectInvalidated(repo.upsert.mock.calls[0]![0] as CachedMessageRecord, ["UNREAD", "Label_1"]);
  });

  it.each([
    { name: "Archive", labels: ["UNREAD"] },
    { name: "Spam", labels: ["SPAM", "UNREAD"] },
    { name: "Trash", labels: ["TRASH", "UNREAD"] }
  ])("leaves the $name cache projection untouched when Gmail rejects the move", async ({ labels }) => {
    const rejection = () => Promise.reject(new Error("permission denied"));
    const { client, repo } = harness({
      modify: labels.includes("TRASH") ? undefined : rejection,
      untrash: labels.includes("TRASH") ? rejection : undefined
    });
    const cached = assessedRow("failed", labels);
    const before = structuredClone(cached);

    const outcome = await moveCachedToInbox(client as never, repo as never, cached, "after");

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.message).toContain("permission denied");
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(cached).toEqual(before);
  });
});

describe("parseCleanupCommand", () => {
  it("accepts the same command line the user would type at a shell prompt", () => {
    expect(parseCleanupCommand("gmail --limit 20")).toEqual({ limit: 20, dryRun: false, archive: false });
    expect(parseCleanupCommand("gmail --limit=20")).toEqual({ limit: 20, dryRun: false, archive: false });
    expect(parseCleanupCommand("  gmail   --limit   20 ")).toEqual({ limit: 20, dryRun: false, archive: false });
  });

  it("accepts the bare command and the flag-only shorthand", () => {
    expect(parseCleanupCommand("gmail")).toEqual({ dryRun: false, archive: false });
    expect(parseCleanupCommand("work")).toEqual({ dryRun: false, archive: false });
    expect(parseCleanupCommand("--limit 5")).toEqual({ limit: 5, dryRun: false, archive: false });
  });

  it("carries the other run flags through", () => {
    expect(parseCleanupCommand("gmail --archive --dry-run --limit 3")).toEqual({
      limit: 3,
      dryRun: true,
      archive: true
    });
  });

  // Anything unrecognized has to fall through to the list's own handling
  // rather than being treated as a mailbox-mutating run.
  it("rejects anything that is not this command", () => {
    for (const input of ["", "q", "u", "2 d", "l 40", "gmail --json", "gmail --limit", "gmail --limit 0", "gmail --limit -3", "gmail --limit abc", "gmailx"]) {
      expect(parseCleanupCommand(input)).toBeNull();
    }
  });
});
