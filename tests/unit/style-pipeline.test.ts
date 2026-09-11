import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWritingStyleProfile } from "../../src/gmail/writing-style.js";
import { draftReply } from "../../src/ai/draft-reply.js";
import { AccountsRepository } from "../../src/state/repositories/accounts.js";
import { openDatabase } from "../../src/state/database.js";
import { SettingsRepository, SETTING_KEYS } from "../../src/state/repositories/settings.js";
import type { GmailClient } from "../../src/gmail/client.js";
import { buildNormalizedMessage, headerMapFromList } from "../../src/gmail/normalize.js";

vi.mock("openai", () => ({ default: vi.fn() }));

import OpenAI from "openai";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A Gmail client whose SENT label holds two messages with a distinctive voice. */
function gmailWithSentMail(): { client: GmailClient; listed: string[][] } {
  const listed: string[][] = [];
  const sent: Record<string, { subject: string; body: string }> = {
    s1: { subject: "Re: invoice", body: "Yep — sending that over this afternoon. Cheers, Sam" },
    s2: { subject: "Re: Tuesday", body: "Works for me. Cheers, Sam" }
  };
  const client = {
    users: {
      messages: {
        list: (params: { labelIds?: string[] }) => {
          listed.push(params.labelIds ?? []);
          return Promise.resolve({
            data: { messages: Object.keys(sent).map((id) => ({ id, threadId: `t-${id}` })) }
          });
        },
        get: (params: { id: string }) => {
          const message = sent[params.id]!;
          return Promise.resolve({
            data: {
              id: params.id,
              threadId: `t-${params.id}`,
              labelIds: ["SENT"],
              internalDate: "1700000000000",
              snippet: message.body,
              payload: {
                headers: [
                  { name: "Subject", value: message.subject },
                  { name: "From", value: "Sam <me@example.com>" }
                ],
                mimeType: "text/plain",
                body: { data: Buffer.from(message.body).toString("base64url") }
              }
            }
          });
        }
      }
    }
  } as unknown as GmailClient;
  return { client, listed };
}

// Built through the real normalizer rather than hand-assembled, so this test
// cannot drift from the shape the drafting path actually receives.
const message = buildNormalizedMessage({
  gmailMessageId: "m1",
  gmailThreadId: "t1",
  historyId: "1",
  internalDate: "1700000000000",
  labelIds: ["INBOX"],
  snippet: "Can you confirm Tuesday?",
  headers: headerMapFromList([
    { name: "From", value: "Dana <dana@example.com>" },
    { name: "Subject", value: "Tuesday?" }
  ]),
  htmlBody: null,
  plainBody: "Can you confirm Tuesday?",
  userEmail: "me@example.com",
  threadHasUserSentMessage: false
});

describe("AI reply style pipeline", () => {
  it("derives the style profile from Sent mail and puts it in the reply request", async () => {
    dir = mkdtempSync(join(tmpdir(), "gmail-agent-style-"));
    const db = openDatabase(join(dir, "state.sqlite"));
    new AccountsRepository(db).upsert({
      accountHash: "acct",
      emailDisplay: "me@example.com",
      timezone: "UTC",
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: "now",
      updatedAt: "now"
    });

    const { client, listed } = gmailWithSentMail();
    const create = vi
      .fn()
      // First call: summarizing the Sent sample into a style description.
      .mockResolvedValueOnce({ output_text: "Brief and warm; signs off with \"Cheers, Sam\"." })
      // Second call: the actual reply draft.
      .mockResolvedValueOnce({ output_text: "Tuesday works. Cheers, Sam" });
    vi.mocked(OpenAI).mockImplementation(() => ({ responses: { create } }) as never);

    const profile = await getWritingStyleProfile({
      db,
      accountHash: "acct",
      gmailClient: client,
      userEmail: "me@example.com",
      credentials: { apiKey: "sk-test", model: "gpt-5.6-luna" },
      nowIso: () => "2026-01-01T00:00:00.000Z"
    });

    // It really read the Sent label, not the inbox.
    expect(listed.flat()).toContain("SENT");
    expect(profile).toContain("Cheers, Sam");

    // The sampled sent mail itself is never persisted — only the description.
    const stored = new SettingsRepository(db).get("acct", SETTING_KEYS.writingStyleProfile);
    expect(stored).toBe(profile);
    const settingsText = JSON.stringify(
      db.prepare("SELECT value FROM settings WHERE account_hash = ?").all("acct")
    );
    expect(settingsText).not.toContain("sending that over this afternoon");

    const draft = await draftReply(message, { apiKey: "sk-test", model: "gpt-5.6-luna" }, { styleProfile: profile });
    expect(draft).toBe("Tuesday works. Cheers, Sam");

    // The style reaches the model as untrusted input, never as instructions.
    const replyRequest = create.mock.calls[1]![0] as { instructions: string; input: unknown };
    expect(JSON.stringify(replyRequest.input)).toContain("Cheers, Sam");
    expect(replyRequest.instructions).not.toContain("Cheers, Sam");

    db.close();
  });
});
