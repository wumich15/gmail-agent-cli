import { describe, expect, it } from "vitest";
import { fetchInboxMessageCount, historyIdGreaterThan, listAllMessageIds, listHistorySince } from "../../src/gmail/scanner.js";
import type { GmailClient } from "../../src/gmail/client.js";

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
