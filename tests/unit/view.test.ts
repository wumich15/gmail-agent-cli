import { describe, expect, it } from "vitest";
import { adjustPageSize, filterMessages } from "../../src/commands/view.js";
import type { CachedMessageRecord } from "../../src/state/repositories/messages.js";

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
