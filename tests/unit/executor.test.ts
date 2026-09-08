import { runScenarios } from "../helpers/scenarios.js";
import { describe, expect, it } from "vitest";
import { applyGroupedLabelMutations, archiveMutation, starOnlyMutation, trashMutation } from "../../src/gmail/executor.js";
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
  it("preserves all 4 scenarios", async () => {
    await runScenarios([
      { name: "groups identical mutations into one call", run: async () => {
    const { client, calls } = fakeClient(() => false);
    const result = await applyGroupedLabelMutations(client, [
      { messageId: "m1", mutation: archiveMutation() },
      { messageId: "m2", mutation: archiveMutation() }
    ]);
    expect(calls).toHaveLength(1);
    expect(result.succeededMessageIds.sort()).toEqual(["m1", "m2"]);
    expect(result.failedMessageIds).toEqual([]);
  } },
      { name: "issues separate calls for different mutations", run: async () => {
    const { client, calls } = fakeClient(() => false);
    await applyGroupedLabelMutations(client, [
      { messageId: "m1", mutation: archiveMutation() },
      { messageId: "m2", mutation: starOnlyMutation() }
    ]);
    expect(calls).toHaveLength(2);
  } },
      { name: "isolates a failing chunk: other groups still succeed and are reported separately", run: async () => {
    const { client } = fakeClient((ids) => ids.includes("bad"));
    const result = await applyGroupedLabelMutations(client, [
      { messageId: "bad", mutation: archiveMutation() },
      { messageId: "good", mutation: starOnlyMutation() }
    ]);
    expect(result.succeededMessageIds).toEqual(["good"]);
    expect(result.failedMessageIds).toEqual(["bad"]);
  } },
      { name: "returns empty results for no input without calling the API", run: async () => {
    const { client, calls } = fakeClient(() => false);
    const result = await applyGroupedLabelMutations(client, []);
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ succeededMessageIds: [], failedMessageIds: [] });
  } }
    ]);
  });
});


it("moves 125 messages to Trash in three reversible batchModify requests", async () => {
  const bodies: unknown[] = [];
  const client = { users: { messages: { batchModify: async ({ requestBody }: { requestBody: unknown }) => {
    bodies.push(requestBody);
    return { data: {} };
  } } } } as unknown as GmailClient;
  const result = await applyGroupedLabelMutations(client, Array.from({ length: 125 }, (_, i) => ({
    messageId: String(i), mutation: trashMutation()
  })));
  expect(bodies).toHaveLength(3);
  expect(bodies[0]).toMatchObject({ addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM"] });
  expect((bodies as { ids: string[] }[]).map((body) => body.ids.length)).toEqual([50, 50, 25]);
  expect(result.succeededMessageIds).toHaveLength(125);
});
