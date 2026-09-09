import { describe, expect, it } from "vitest";
import { loadSentStyleExamples } from "../../src/gmail/sent-style.js";
import type { GmailClient } from "../../src/gmail/client.js";

describe("loadSentStyleExamples", () => {
  it("loads normalized recent Sent bodies without persisting them", async () => {
    const client = {
      users: {
        messages: {
          list: async () => ({ data: { messages: [{ id: "sent-1", threadId: "thread-1" }] } }),
          get: async () => ({ data: {
            id: "sent-1", threadId: "thread-1", historyId: "2", internalDate: "1000", labelIds: ["SENT"],
            snippet: "Quick note", payload: {
              mimeType: "text/plain", body: { data: Buffer.from("Hey Alice,\n\nQuick note.\n\n-M").toString("base64url") },
              headers: [{ name: "From", value: "Me <me@example.com>" }, { name: "Subject", value: "Checking in" }]
            }
          } })
        }
      }
    } as unknown as GmailClient;

    expect(await loadSentStyleExamples(client, "me@example.com")).toEqual([
      { subject: "Checking in", body: "Hey Alice,\n\nQuick note.\n\n-M" }
    ]);
  });

  it("falls back to no style examples when Sent cannot be listed", async () => {
    const client = {
      users: { messages: { list: async () => { throw new Error("offline"); } } }
    } as unknown as GmailClient;
    expect(await loadSentStyleExamples(client, "me@example.com")).toEqual([]);
  });
});
