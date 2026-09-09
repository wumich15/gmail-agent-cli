import type { GmailClient } from "./client.js";
import type { GmailAgentDatabase } from "../state/database.js";
import { SettingsRepository, SETTING_KEYS } from "../state/repositories/settings.js";
import { loadSentStyleExamples } from "./sent-style.js";
import { summarizeWritingStyle, type DraftReplyOptions } from "../ai/draft-reply.js";

export interface WritingStyleDeps {
  db: GmailAgentDatabase;
  accountHash: string;
  gmailClient: GmailClient;
  userEmail: string;
  credentials: DraftReplyOptions;
  nowIso: () => string;
}

/**
 * Returns the account's persisted writing-style profile, computing and
 * saving it once (from a live Sent-mail sample) if none exists yet or
 * `forceRefresh` is set, instead of re-deriving it from Gmail on every
 * single AI draft. Only the bounded, non-verbatim description
 * `summarizeWritingStyle` produces is ever written to SQLite — never the
 * raw sent-mail examples it was built from (CLAUDE.md forbids persisting
 * message bodies).
 */
export async function getWritingStyleProfile(deps: WritingStyleDeps, forceRefresh = false): Promise<string | null> {
  const settings = new SettingsRepository(deps.db);
  if (!forceRefresh) {
    const existing = settings.get(deps.accountHash, SETTING_KEYS.writingStyleProfile);
    if (existing) return existing;
  }
  const examples = await loadSentStyleExamples(deps.gmailClient, deps.userEmail);
  const profile = await summarizeWritingStyle(examples, deps.credentials);
  if (profile) {
    settings.set(deps.accountHash, SETTING_KEYS.writingStyleProfile, profile, deps.nowIso());
  }
  return profile;
}
