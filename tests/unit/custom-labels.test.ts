import { describe, expect, it } from "vitest";
import { getOrCreateLabelId, listUserLabels } from "../../src/gmail/custom-labels.js";
import type { GmailClient } from "../../src/gmail/client.js";

function fakeClient(overrides: {
  labels?: { id: string; name: string; type: string }[];
  create?: (name: string) => { id?: string } | Promise<never>;
}): GmailClient {
  return {
    users: {
      labels: {
        list: async () => ({ data: { labels: overrides.labels ?? [] } }),
        create: async ({ requestBody }: { requestBody: { name?: string | null } }) => {
          const result = overrides.create?.(requestBody.name ?? "");
          if (result === undefined) {
            return { data: { id: "new-id" } };
          }
          return { data: await result };
        }
      }
    }
  } as unknown as GmailClient;
}

describe("listUserLabels", () => {
  it("includes only user-type labels, excluding system labels like INBOX/STARRED", async () => {
    const client = fakeClient({
      labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "Label_1", name: "Shopping", type: "user" }
      ]
    });
    const labels = await listUserLabels(client);
    expect(labels).toEqual([{ id: "Label_1", name: "Shopping" }]);
  });
});

describe("getOrCreateLabelId", () => {
  it("reuses a known label id without calling create, matching case-insensitively", async () => {
    let createCalled = false;
    const client = fakeClient({
      create: () => {
        createCalled = true;
        return { id: "should-not-be-used" };
      }
    });
    const known = new Map([["shopping", "Label_1"]]);
    const id = await getOrCreateLabelId(client, "Shopping", known);
    expect(id).toBe("Label_1");
    expect(createCalled).toBe(false);
  });

  it("creates a new label and records it in the known-labels map for reuse", async () => {
    const client = fakeClient({ create: () => ({ id: "Label_2" }) });
    const known = new Map<string, string>();
    const id = await getOrCreateLabelId(client, "Travel", known);
    expect(id).toBe("Label_2");
    expect(known.get("travel")).toBe("Label_2");
  });

  it("falls back to the matching label from a fresh list on a 409 (concurrent creation)", async () => {
    let listCallCount = 0;
    const client: GmailClient = {
      users: {
        labels: {
          list: async () => {
            listCallCount += 1;
            return { data: { labels: [{ id: "Label_3", name: "Travel", type: "user" }] } };
          },
          create: async () => {
            const error = Object.assign(new Error("conflict"), { status: 409 });
            throw error;
          }
        }
      }
    } as unknown as GmailClient;
    const known = new Map<string, string>();
    const id = await getOrCreateLabelId(client, "Travel", known);
    expect(id).toBe("Label_3");
    expect(listCallCount).toBe(1);
  });
});
