import { describe, expect, it } from "vitest";
import type { gmail_v1 } from "googleapis";
import { projectHydratedCacheMessage } from "../../src/gmail/cache-projection.js";
import { selectCachedBacklogStubs } from "../../src/commands/work.js";

const stub = { id: "message1", threadId: "old-thread" };
const raw: gmail_v1.Schema$Message = {
  id: stub.id,
  threadId: "live-thread",
  labelIds: ["INBOX", "UNREAD"],
  internalDate: "1000",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Sender <sender@example.com>" },
      { name: "Subject", value: "A message" }
    ],
    body: { data: Buffer.from("Private body text").toString("base64url") }
  }
};
const versions = {
  classifierVersion: "model1",
  promptVersion: "prompt1",
  schemaVersion: "schema1",
  policyVersion: "policy1"
};

describe("cache message projection", () => {
  it("keeps a matching assessment, uses the live thread ID, and excludes bodies", () => {
    const initial = projectHydratedCacheMessage("account", "me@example.com", "first", stub, raw, null)!;
    const existing = { ...initial, ...versions, assessmentKind: "personal_routine", assessmentHadEvent: false };
    const next = projectHydratedCacheMessage(
      "account", "me@example.com", "later", stub, { ...raw, labelIds: ["UNREAD", "INBOX"] }, existing
    )!;
    expect(next.gmailThreadId).toBe("live-thread");
    expect(next.classifierVersion).toBe("model1");
    expect(next.processedAt).toBe("first");
    expect(JSON.stringify(next)).not.toContain("Private body text");
    expect(selectCachedBacklogStubs([next], versions)).toEqual([]);
  });

  it("queues newly read messages for work even when their content hash is unchanged", () => {
    const initial = projectHydratedCacheMessage("account", "me@example.com", "first", stub, raw, null)!;
    const existing = { ...initial, ...versions, assessmentKind: "personal_routine", assessmentHadEvent: false };
    const next = projectHydratedCacheMessage(
      "account", "me@example.com", "later", stub, { ...raw, labelIds: ["INBOX"] }, existing
    )!;
    expect(next.contentHash).toBe(existing.contentHash);
    expect(next.classifierVersion).toBeNull();
    expect(next.assessmentKind).toBeNull();
    expect(selectCachedBacklogStubs([next], versions)).toEqual([{ id: stub.id, threadId: "live-thread" }]);
  });

  it("invalidates changed content and evicts messages outside the working set", () => {
    const initial = projectHydratedCacheMessage("account", "me@example.com", "first", stub, raw, null)!;
    const existing = { ...initial, ...versions };
    const next = projectHydratedCacheMessage(
      "account", "me@example.com", "later", stub,
      { ...raw, payload: { ...raw.payload, body: { data: Buffer.from("Changed body").toString("base64url") } } }, existing
    )!;
    expect(next.contentHash).not.toBe(existing.contentHash);
    expect(next.policyVersion).toBeNull();
    expect(projectHydratedCacheMessage("account", "me@example.com", "later", stub, { ...raw, labelIds: ["TRASH"] }, existing)).toBeNull();
  });

  it("retains Archive and Trash for view scope without broadening the default working scope", () => {
    const archive = { ...raw, labelIds: ["UNREAD", "STARRED"] };
    const trash = { ...raw, labelIds: ["TRASH"] };

    expect(projectHydratedCacheMessage("account", "me@example.com", "now", stub, archive, null)).toBeNull();
    expect(projectHydratedCacheMessage("account", "me@example.com", "now", stub, trash, null)).toBeNull();

    expect(
      projectHydratedCacheMessage("account", "me@example.com", "now", stub, archive, null, "view")?.labelSnapshot
    ).toEqual(["UNREAD", "STARRED"]);
    expect(
      projectHydratedCacheMessage("account", "me@example.com", "now", stub, trash, null, "view")?.labelSnapshot
    ).toEqual(["TRASH"]);
  });

  it("rejects a response for a different message", () => {
    expect(() => projectHydratedCacheMessage("account", "me@example.com", "now", stub, { ...raw, id: "wrong" }, null)).toThrow("different message ID");
  });
});
