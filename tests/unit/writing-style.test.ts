import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWritingStyleProfile } from "../../src/gmail/writing-style.js";
import { SettingsRepository, SETTING_KEYS } from "../../src/state/repositories/settings.js";
import { AccountsRepository } from "../../src/state/repositories/accounts.js";
import { openDatabase, type GmailAgentDatabase } from "../../src/state/database.js";
import type { GmailClient } from "../../src/gmail/client.js";

vi.mock("../../src/gmail/sent-style.js", () => ({
  loadSentStyleExamples: vi.fn().mockResolvedValue([{ subject: "Hi", body: "Hey! Talk soon." }])
}));
vi.mock("../../src/ai/draft-reply.js", () => ({
  summarizeWritingStyle: vi.fn().mockResolvedValue("Casual, brief, signs off 'Talk soon.'")
}));

import { loadSentStyleExamples } from "../../src/gmail/sent-style.js";
import { summarizeWritingStyle } from "../../src/ai/draft-reply.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function testDb(): GmailAgentDatabase {
  dir = mkdtempSync(join(tmpdir(), "gmail-agent-test-"));
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
  return db;
}

const credentials = { apiKey: "sk-test", model: "gpt-5.4-mini" };
const fakeClient = {} as GmailClient;

describe("getWritingStyleProfile", () => {
  it("computes and persists a profile on first use, never storing the raw sent examples", async () => {
    const db = testDb();
    const profile = await getWritingStyleProfile({
      db, accountHash: "acct", gmailClient: fakeClient, userEmail: "me@example.com", credentials, nowIso: () => "2026-01-01T00:00:00Z"
    });
    expect(profile).toBe("Casual, brief, signs off 'Talk soon.'");
    expect(loadSentStyleExamples).toHaveBeenCalledTimes(1);
    expect(summarizeWritingStyle).toHaveBeenCalledTimes(1);
    const stored = new SettingsRepository(db).get("acct", SETTING_KEYS.writingStyleProfile);
    expect(stored).toBe("Casual, brief, signs off 'Talk soon.'");
    // The raw example body must never end up anywhere in the settings table.
    const row = db.prepare("SELECT value FROM settings WHERE account_hash = ?").get("acct") as { value: string };
    expect(row.value).not.toContain("Hey! Talk soon.");
  });

  it("reuses the persisted profile on a later call instead of re-deriving it from Gmail/AI", async () => {
    const db = testDb();
    new SettingsRepository(db).set("acct", SETTING_KEYS.writingStyleProfile, "Already saved style.", "2026-01-01T00:00:00Z");
    vi.mocked(loadSentStyleExamples).mockClear();
    vi.mocked(summarizeWritingStyle).mockClear();

    const profile = await getWritingStyleProfile({
      db, accountHash: "acct", gmailClient: fakeClient, userEmail: "me@example.com", credentials, nowIso: () => "2026-01-02T00:00:00Z"
    });
    expect(profile).toBe("Already saved style.");
    expect(loadSentStyleExamples).not.toHaveBeenCalled();
    expect(summarizeWritingStyle).not.toHaveBeenCalled();
  });

  it("forceRefresh recomputes and overwrites the saved profile even when one already exists", async () => {
    const db = testDb();
    new SettingsRepository(db).set("acct", SETTING_KEYS.writingStyleProfile, "Stale style.", "2026-01-01T00:00:00Z");
    vi.mocked(loadSentStyleExamples).mockClear();
    vi.mocked(summarizeWritingStyle).mockClear().mockResolvedValueOnce("Freshly recomputed style.");

    const profile = await getWritingStyleProfile(
      { db, accountHash: "acct", gmailClient: fakeClient, userEmail: "me@example.com", credentials, nowIso: () => "2026-01-03T00:00:00Z" },
      true
    );
    expect(profile).toBe("Freshly recomputed style.");
    expect(loadSentStyleExamples).toHaveBeenCalledTimes(1);
    expect(new SettingsRepository(db).get("acct", SETTING_KEYS.writingStyleProfile)).toBe("Freshly recomputed style.");
  });

  it("does not persist anything when summarization fails, leaving no stale/empty value", async () => {
    const db = testDb();
    vi.mocked(summarizeWritingStyle).mockClear().mockResolvedValueOnce(null);
    const profile = await getWritingStyleProfile({
      db, accountHash: "acct", gmailClient: fakeClient, userEmail: "me@example.com", credentials, nowIso: () => "2026-01-01T00:00:00Z"
    });
    expect(profile).toBeNull();
    expect(new SettingsRepository(db).get("acct", SETTING_KEYS.writingStyleProfile)).toBeNull();
  });
});
