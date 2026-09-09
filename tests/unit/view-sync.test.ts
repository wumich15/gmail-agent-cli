import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type GmailAgentDatabase } from "../../src/state/database.js";
import { AccountsRepository } from "../../src/state/repositories/accounts.js";
import { MessagesRepository, type CachedMessageRecord } from "../../src/state/repositories/messages.js";
import { refreshViewCache } from "../../src/gmail/view-sync.js";
import type { GmailClient } from "../../src/gmail/client.js";
import type { AccountRecord } from "../../src/core/models.js";

let directory: string;
let db: GmailAgentDatabase;
let account: AccountRecord;

function cached(id: string): CachedMessageRecord {
  return {
    accountHash: "account", gmailMessageId: id, gmailThreadId: `thread-${id}`, contentHash: "old",
    labelSnapshot: ["INBOX", "UNREAD"], classifierVersion: null, promptVersion: null, schemaVersion: null,
    policyVersion: null, assessmentKind: null, assessmentConfidence: null, importanceScore: null,
    importanceConfidence: null, reasonCodes: null, processedAt: "earlier", subject: "Old", senderDisplay: "Old sender",
    internalDate: "1000", category: null, assessmentHadEvent: null
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "gmail-view-sync-"));
  db = openDatabase(join(directory, "state.sqlite"));
  account = {
    accountHash: "account", emailDisplay: "me@example.com", timezone: "UTC", historyMarker: "10",
    setupComplete: true, automationEnabled: false, createdAt: "earlier", updatedAt: "earlier"
  };
  new AccountsRepository(db).upsert(account);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("refreshViewCache", () => {
  it("requests a full snapshot when no Gmail history fence exists", async () => {
    const result = await refreshViewCache(db, {} as GmailClient, { ...account, historyMarker: null }, "now");
    expect(result.kind).toBe("full_required");
  });

  it("hydrates new history messages, evicts deleted cache rows, and advances the fence", async () => {
    new MessagesRepository(db).upsert(cached("deleted"));
    const client = {
      users: {
        history: {
          list: async () => ({ data: {
            history: [
              { id: "11", messagesAdded: [{ message: { id: "new", threadId: "thread-new" } }] },
              { id: "12", messagesDeleted: [{ message: { id: "deleted", threadId: "thread-deleted" } }] }
            ],
            historyId: "12"
          } })
        },
        messages: {
          get: async () => ({ data: {
            id: "new", threadId: "thread-new", historyId: "11", internalDate: "2000",
            labelIds: ["INBOX", "UNREAD"], snippet: "Hello", payload: {
              mimeType: "text/plain", body: { data: Buffer.from("Hello there").toString("base64url") },
              headers: [{ name: "From", value: "Alice <alice@example.com>" }, { name: "Subject", value: "A new note" }]
            }
          } })
        }
      }
    } as unknown as GmailClient;

    const result = await refreshViewCache(db, client, account, "now");

    expect(result).toEqual({ kind: "incremental", added: 1, updated: 0, removed: 1, failed: 0 });
    const messages = new MessagesRepository(db);
    expect(messages.get("account", "new")?.subject).toBe("A new note");
    expect(messages.get("account", "deleted")).toBeNull();
    expect(new AccountsRepository(db).get("account")?.historyMarker).toBe("12");
  });

  it("retains the old fence when one changed message cannot be hydrated", async () => {
    const client = {
      users: {
        history: { list: async () => ({ data: {
          history: [{ id: "11", messagesAdded: [{ message: { id: "bad", threadId: "thread-bad" } }] }],
          historyId: "11"
        } }) },
        messages: { get: async () => { throw Object.assign(new Error("bad request"), { code: 400 }); } }
      }
    } as unknown as GmailClient;

    const result = await refreshViewCache(db, client, account, "now");

    expect(result.failed).toBe(1);
    expect(new AccountsRepository(db).get("account")?.historyMarker).toBe("10");
  });
});
