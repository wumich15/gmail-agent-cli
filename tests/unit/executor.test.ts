import { describe, expect, it } from "vitest";
import { applyGroupedLabelMutations, archiveMutation, starOnlyMutation } from "../../src/gmail/executor.js";
import type { GmailClient } from "../../src/gmail/client.js";

function fakeClient(shouldFail: (ids: string[]) => boolean) {
  const calls: string[][] = [];
  const client = {
    users: {
      messages: {
        batchModify: async ({ requestBody }: { requestBody: { ids: string[] } }) => {
          calls.push(requestBody.ids);
          if (shouldFail(requestBody.ids)) {
            throw new Error("simulated batchModify failure");
          }
          return { data: {} };
        }
      }
    }
  };
  return { client: client as unknown as GmailClient, calls };
}

describe("applyGroupedLabelMutations", () => {
  it("groups identical mutations into one call", async () => {
    const { client, calls } = fakeClient(() => false);
    const result = await applyGroupedLabelMutations(client, [
      { messageId: "m1", mutation: archiveMutation() },
      { messageId: "m2", mutation: archiveMutation() }
    ]);
    expect(calls).toHaveLength(1);
    expect(result.succeededMessageIds.sort()).toEqual(["m1", "m2"]);
    expect(result.failedMessageIds).toEqual([]);
  });

  it("issues separate calls for different mutations", async () => {
    const { client, calls } = fakeClient(() => false);
    await applyGroupedLabelMutations(client, [
      { messageId: "m1", mutation: archiveMutation() },
      { messageId: "m2", mutation: starOnlyMutation() }
    ]);
    expect(calls).toHaveLength(2);
  });

  it("isolates a failing chunk: other groups still succeed and are reported separately", async () => {
    const { client } = fakeClient((ids) => ids.includes("bad"));
    const result = await applyGroupedLabelMutations(client, [
      { messageId: "bad", mutation: archiveMutation() },
      { messageId: "good", mutation: starOnlyMutation() }
    ]);
    expect(result.succeededMessageIds).toEqual(["good"]);
    expect(result.failedMessageIds).toEqual(["bad"]);
  });

  it("returns empty results for no input without calling the API", async () => {
    const { client, calls } = fakeClient(() => false);
    const result = await applyGroupedLabelMutations(client, []);
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ succeededMessageIds: [], failedMessageIds: [] });
  });
});
