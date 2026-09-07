import { describe, expect, it } from "vitest";
import {
  fetchInboxMessageCount,
  fetchMessageFull,
  fetchProfile,
  historyIdGreaterThan,
  listAllMessageIds,
  listHistorySince,
  listSentThreadIds,
  headersFromMessage,
  MESSAGE_LIST_FIELDS,
  PROFILE_FIELDS
} from "../../src/gmail/scanner.js";
import { buildNormalizedMessage, extractBodyParts } from "../../src/gmail/normalize.js";
import type { GmailClient } from "../../src/gmail/client.js";
import type { gmail_v1 } from "googleapis";

function fakeListClient(pages: { messages: { id: string; threadId: string }[]; resultSizeEstimate: number }[]) {
  let pageIndex = 0;
  const client = {
    users: {
      messages: {
        list: async () => {
          const page = pages[pageIndex]!;
          pageIndex += 1;
          const hasMore = pageIndex < pages.length;
          return {
            data: {
              messages: page.messages,
              resultSizeEstimate: page.resultSizeEstimate,
              nextPageToken: hasMore ? `token-${pageIndex}` : undefined
            }
          };
        }
      }
    }
  };
  return client as unknown as GmailClient;
}

function stub(id: string) {
  return { id, threadId: `t-${id}` };
}

describe("historyIdGreaterThan", () => {
  it("compares numerically, not lexicographically", () => {
    // A pure string comparison would say "99" > "100" (wrong).
    expect(historyIdGreaterThan("100", "99")).toBe(true);
    expect(historyIdGreaterThan("99", "100")).toBe(false);
  });

  it("handles values beyond Number.MAX_SAFE_INTEGER", () => {
    expect(historyIdGreaterThan("9007199254740993", "9007199254740992")).toBe(true);
  });

  it("is false for equal values", () => {
    expect(historyIdGreaterThan("42", "42")).toBe(false);
  });
});

describe("listAllMessageIds with safetyCapCount", () => {
  it("trims the result to exactly the cap even when a single page over-fills it", async () => {
    // Regression: the cap used to only stop pagination, not trim the
    // array, so a single 500-result page would blow straight through a
    // small cap and every one of those IDs would still get a full
    // messages.get call — defeating the point of capping at all.
    const client = fakeListClient([
      { messages: [stub("a"), stub("b"), stub("c"), stub("d"), stub("e")], resultSizeEstimate: 500 }
    ]);
    const result = await listAllMessageIds(client, {
      labelIds: ["INBOX"],
      includeSpamTrash: false,
      safetyCapCount: 2
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.truncated).toBe(true);
    expect(result.estimatedTotal).toBe(500);
  });

  it("does not paginate further once the cap is reached", async () => {
    const client = fakeListClient([
      { messages: [stub("a"), stub("b")], resultSizeEstimate: 10 },
      { messages: [stub("c"), stub("d")], resultSizeEstimate: 10 }
    ]);
    const result = await listAllMessageIds(client, {
      labelIds: ["INBOX"],
      includeSpamTrash: false,
      safetyCapCount: 2
    });
    expect(result.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("is not truncated when everything fits under the cap", async () => {
    const client = fakeListClient([{ messages: [stub("a")], resultSizeEstimate: 1 }]);
    const result = await listAllMessageIds(client, {
      labelIds: ["INBOX"],
      includeSpamTrash: false,
      safetyCapCount: 10
    });
    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(1);
  });

  it("without a cap, fetches everything across pages", async () => {
    const client = fakeListClient([
      { messages: [stub("a")], resultSizeEstimate: 2 },
      { messages: [stub("b")], resultSizeEstimate: 2 }
    ]);
    const result = await listAllMessageIds(client, { labelIds: ["INBOX"], includeSpamTrash: false });
    expect(result.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.truncated).toBe(false);
  });
});

describe("listHistorySince", () => {
  function fakeHistoryClient(pages: Record<string, unknown>[]) {
    let pageIndex = 0;
    const client = {
      users: {
        history: {
          list: async () => {
            const page = pages[pageIndex]!;
            pageIndex += 1;
            return { data: page };
          }
        }
      }
    };
    return client as unknown as GmailClient;
  }

  it("preserves each changed message's threadId from the history record, not just its id", async () => {
    const client = fakeHistoryClient([
      {
        history: [{ id: "150", labelsAdded: [{ message: { id: "m1", threadId: "t1" } }] }],
        historyId: "150"
      }
    ]);
    const result = await listHistorySince(client, "100");
    expect(result.changedMessages.get("m1")).toBe("t1");
    expect(result.expiredMarker).toBe(false);
    expect(result.endHistoryId).toBe("150");
  });

  it("removes a message from changedMessages once it appears in messagesDeleted", async () => {
    const client = fakeHistoryClient([
      {
        history: [
          { id: "150", labelsAdded: [{ message: { id: "m1", threadId: "t1" } }] },
          { id: "151", messagesDeleted: [{ message: { id: "m1", threadId: "t1" } }] }
        ],
        historyId: "151"
      }
    ]);
    const result = await listHistorySince(client, "100");
    expect(result.changedMessages.has("m1")).toBe(false);
    expect(result.deletedMessageIds.has("m1")).toBe(true);
  });

  it("reports an expired marker on a 404 rather than throwing", async () => {
    const client = {
      users: {
        history: {
          list: async () => {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
        }
      }
    } as unknown as GmailClient;
    const result = await listHistorySince(client, "stale");
    expect(result.expiredMarker).toBe(true);
    expect(result.endHistoryId).toBe("stale");
  });
});

describe("fetchInboxMessageCount", () => {
  it("returns messagesTotal from a single users.labels.get call", async () => {
    const client = {
      users: { labels: { get: async () => ({ data: { messagesTotal: 37 } }) } }
    } as unknown as GmailClient;
    expect(await fetchInboxMessageCount(client)).toBe(37);
  });

  it("defaults to 0 when messagesTotal is absent", async () => {
    const client = { users: { labels: { get: async () => ({ data: {} }) } } } as unknown as GmailClient;
    expect(await fetchInboxMessageCount(client)).toBe(0);
  });
});

describe("partial-response `fields` selectors", () => {
  it("fetchMessageFull requests format=full narrowed by MESSAGE_FULL_FIELDS", async () => {
    let capturedParams: unknown;
    const client = {
      users: {
        messages: {
          get: async (params: unknown) => {
            capturedParams = params;
            return { data: { id: "m1", threadId: "t1" } };
          }
        }
      }
    } as unknown as GmailClient;
    await fetchMessageFull(client, "m1");
    expect(capturedParams).toMatchObject({ format: "full", fields: expect.stringContaining("payload(") });
  });

  it("listAllMessageIds and fetchProfile request their documented field selectors", async () => {
    let listParams: unknown;
    let profileParams: unknown;
    const client = {
      users: {
        messages: {
          list: async (params: unknown) => {
            listParams = params;
            return { data: { messages: [], resultSizeEstimate: 0 } };
          }
        },
        getProfile: async (params: unknown) => {
          profileParams = params;
          return { data: { emailAddress: "me@example.com", historyId: "1" } };
        }
      }
    } as unknown as GmailClient;
    await listAllMessageIds(client, { labelIds: ["INBOX"], includeSpamTrash: false });
    await fetchProfile(client);
    expect(listParams).toMatchObject({ fields: MESSAGE_LIST_FIELDS });
    expect(profileParams).toMatchObject({ fields: PROFILE_FIELDS });
  });

  /**
   * Proves CLAUDE.md's partial-response requirement: "Add fixtures proving
   * the narrowed response produces identical normalized messages" — a raw
   * Gmail response containing every field a real message could carry
   * (including several MESSAGE_FULL_FIELDS deliberately excludes, like
   * payload.partId/filename and a message-level sizeEstimate) must
   * normalize identically to one pre-trimmed to exactly the fields that
   * selector requests, down through a 3-level nested MIME tree well within
   * MESSAGE_FULL_PART_TREE_DEPTH.
   */
  it("a response narrowed to exactly MESSAGE_FULL_FIELDS normalizes identically to the untrimmed original", () => {
    const fullRaw: gmail_v1.Schema$Message = {
      id: "m1",
      threadId: "t1",
      historyId: "500",
      internalDate: "1700000000000",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Hello there",
      sizeEstimate: 4096, // excluded by MESSAGE_FULL_FIELDS
      payload: {
        partId: "0", // excluded by MESSAGE_FULL_FIELDS
        filename: "", // excluded by MESSAGE_FULL_FIELDS
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "person@example.com" },
          { name: "Subject", value: "Hi" }
        ],
        body: { size: 0 },
        parts: [
          {
            partId: "0.0",
            mimeType: "multipart/alternative",
            body: { size: 0 },
            parts: [
              {
                partId: "0.0.0",
                mimeType: "text/plain",
                filename: "",
                body: { size: 5, data: Buffer.from("plain").toString("base64url") },
                parts: []
              },
              {
                partId: "0.0.1",
                mimeType: "text/html",
                body: { size: 15, data: Buffer.from("<p>html</p>").toString("base64url") },
                parts: []
              }
            ]
          }
        ]
      }
    };

    // Only the fields MESSAGE_FULL_FIELDS actually selects survive here —
    // this is what Gmail's real server would return for that `fields` value.
    const narrowedRaw: gmail_v1.Schema$Message = {
      id: "m1",
      threadId: "t1",
      historyId: "500",
      internalDate: "1700000000000",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Hello there",
      payload: {
        mimeType: fullRaw.payload!.mimeType ?? null,
        headers: fullRaw.payload!.headers ?? [],
        body: { data: fullRaw.payload!.body?.data ?? null },
        parts: fullRaw.payload!.parts!.map((p0) => ({
          mimeType: p0.mimeType ?? null,
          body: { data: p0.body?.data ?? null },
          parts: p0.parts!.map((p1) => ({
            mimeType: p1.mimeType ?? null,
            body: { data: p1.body?.data ?? null },
            parts: []
          }))
        }))
      }
    };

    function normalizeOf(raw: gmail_v1.Schema$Message) {
      const { plain, html } = extractBodyParts(raw.payload ?? undefined);
      return buildNormalizedMessage({
        gmailMessageId: raw.id!,
        gmailThreadId: raw.threadId!,
        historyId: raw.historyId!,
        internalDate: raw.internalDate!,
        labelIds: raw.labelIds ?? [],
        snippet: raw.snippet ?? "",
        headers: headersFromMessage(raw),
        htmlBody: html,
        plainBody: plain,
        userEmail: "me@example.com",
        threadHasUserSentMessage: false
      });
    }

    expect(normalizeOf(narrowedRaw)).toEqual(normalizeOf(fullRaw));
  });
});

describe("listSentThreadIds", () => {
  it("builds a local reply-protection index from cheap message stubs", async () => {
    const client = fakeListClient([
      {
        messages: [stub("sent-1"), { id: "sent-2", threadId: "shared-thread" }],
        resultSizeEstimate: 2
      }
    ]);
    expect([...await listSentThreadIds(client)]).toEqual(["t-sent-1", "shared-thread"]);
  });
});
