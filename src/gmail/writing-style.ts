import type { GmailClient } from "./client.js";
import { sentMailStyleSamplingAllowed } from "../config/schema.js";
import type { Config } from "../config/schema.js";
import type { GmailAgentDatabase } from "../state/database.js";
import { SettingsRepository, SETTING_KEYS } from "../state/repositories/settings.js";
import { loadSentStyleExamples } from "./sent-style.js";
import { summarizeWritingStyle, type DraftReplyOptions } from "../ai/draft-reply.js";

export interface WritingStyleDeps {
  /**
   * The active config, so this can refuse to sample Sent mail under the
   * hosted AI service. Omitted by callers that predate hosted AI; omission is
   * read as "allowed", which is correct for every local provider.
   */
  config?: Config | null;
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
 *
 * Under the hosted AI service this returns null without reading Sent mail at
 * all, and without handing back a profile derived under an earlier provider:
 * that sample is a dozen unrelated messages the user did not select for this
 * draft, the hosted disclosure does not claim it, and silently migrating an
 * existing profile into a new service would be exactly the kind of quiet
 * scope creep the disclosure exists to prevent. Drafts fall back to the
 * user's own typed guidance, which is what they can see and control.
 */
export async function getWritingStyleProfile(deps: WritingStyleDeps, forceRefresh = false): Promise<string | null> {
  if (!sentMailStyleSamplingAllowed(deps.config ?? null)) return null;
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
