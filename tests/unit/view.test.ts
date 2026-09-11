import { describe, expect, it, vi, afterEach } from "vitest";
import type { CachedMessageRecord } from "../../src/state/repositories/messages.js";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const {
  adjustPageSize,
  filterMessages,
  parseQuickActionCommand,
  shortenLinksForDisplay,
  terminalHyperlink,
  openUrlInBrowser,
  trashCached
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

describe("gmail view quick-action shorthand", () => {
  it("parses '<n> ;r' as an immediate AI-reply on message n", () => {
    expect(parseQuickActionCommand("2 ;r")).toEqual({ index: 2, action: "ai_reply" });
  });

  it("parses '<n> r' as an immediate manual reply", () => {
    expect(parseQuickActionCommand("3 r")).toEqual({ index: 3, action: "reply" });
  });

  it("parses '<n> d' as an immediate delete", () => {
    expect(parseQuickActionCommand("1 d")).toEqual({ index: 1, action: "delete" });
  });

  it("tolerates no space between the number and the action", () => {
    expect(parseQuickActionCommand("2;r")).toEqual({ index: 2, action: "ai_reply" });
  });

  it("returns null for a bare index (still opens normally) and for garbage", () => {
    expect(parseQuickActionCommand("2")).toBeNull();
    expect(parseQuickActionCommand("2 x")).toBeNull();
    expect(parseQuickActionCommand("r")).toBeNull();
    expect(parseQuickActionCommand("0 d")).toBeNull();
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
    const client = { users: { messages: { trash } } };
    const repo = { delete: vi.fn() };
    return { client, repo, trash };
  }

  it("moves the message to Trash and evicts the local row, returning the record that makes \";u\" work", async () => {
    const { client, repo, trash } = harness();
    const message = row("m1", ["INBOX"], "Junk", "Store");

    // No prompt module is involved at all: this path asks nothing.
    const result = await trashCached(client as never, repo as never, message);

    expect(result).toEqual({ ok: true, record: message });
    expect(trash).toHaveBeenCalledWith({ userId: "me", id: "m1" }, expect.anything());
    expect(repo.delete).toHaveBeenCalledWith("account", "m1");
  });

  it("never reaches a permanent-delete endpoint", async () => {
    const trash = vi.fn().mockResolvedValue({});
    const del = vi.fn();
    const batchDelete = vi.fn();
    const client = { users: { messages: { trash, delete: del, batchDelete } } };
    await trashCached(client as never, { delete: vi.fn() } as never, row("m1", ["INBOX"], "Junk", "Store"));
    expect(del).not.toHaveBeenCalled();
    expect(batchDelete).not.toHaveBeenCalled();
  });

  it("records no undo and keeps the cached row when Gmail rejects the delete", async () => {
    const { client, repo } = harness(() => Promise.reject(new Error("permission denied")));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await trashCached(client as never, repo as never, row("m1", ["INBOX"], "Junk", "Store"));

    expect(result.ok).toBe(false);
    expect(repo.delete).not.toHaveBeenCalled();
    // The failure is returned, not printed: "dd" clears the screen on its
    // next render, so a printed error would vanish and the message would
    // look deleted when it is still in the mailbox.
    expect(errors).not.toHaveBeenCalled();
    expect(result.ok ? "" : result.message).toContain("permission denied");
  });
});
