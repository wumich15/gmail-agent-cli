import type { GmailClient } from "./client.js";
import { sentMailStyleSamplingAllowed } from "../config/schema.js";
import type { Config } from "../config/schema.js";
import type { GmailAgentDatabase } from "../state/database.js";
import { SettingsRepository, SETTING_KEYS } from "../state/repositories/settings.js";
import { loadSentStyleExamples } from "./sent-style.js";
import { summarizeWritingStyle, type DraftReplyOptions } from "../ai/draft-reply.js";

/**
 * How long a failed derivation suppresses the next attempt.
 *
 * Long enough that an account with no Sent mail does not pay for a Gmail
 * listing plus an AI call on every single draft, short enough that a
 * mailbox which has since been used starts imitating the user's style
 * without them having to know that ";s" exists.
 */
const UNAVAILABLE_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

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
 * A derivation that produces nothing is remembered too, as a timestamp.
 * Persisting only successes meant an account with no usable Sent sample
 * repeated the whole Sent listing and summarization call before every
 * draft, indefinitely, always to reach the same empty answer; the
 * timestamp backs that off for a week and then lets the account try again
 * on its own. An explicit ";s" ignores it entirely.
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
  const now = deps.nowIso();
  if (!forceRefresh) {
    const existing = settings.get(deps.accountHash, SETTING_KEYS.writingStyleProfile);
    if (existing) return existing;
    if (recentlyFoundUnavailable(settings.get(deps.accountHash, SETTING_KEYS.writingStyleProfileUnavailableAt), now)) {
      return null;
    }
  }
  const examples = await loadSentStyleExamples(deps.gmailClient, deps.userEmail);
  const profile = await summarizeWritingStyle(examples, deps.credentials);
  if (profile) {
    settings.set(deps.accountHash, SETTING_KEYS.writingStyleProfile, profile, now);
    settings.delete(deps.accountHash, SETTING_KEYS.writingStyleProfileUnavailableAt);
  } else {
    settings.set(deps.accountHash, SETTING_KEYS.writingStyleProfileUnavailableAt, now, now);
  }
  return profile;
}

/** An unparseable or absent marker always means "try again now". */
function recentlyFoundUnavailable(markedAt: string | null, nowIso: string): boolean {
  if (!markedAt) return false;
  const marked = Date.parse(markedAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(marked) || !Number.isFinite(now)) return false;
  return now - marked >= 0 && now - marked < UNAVAILABLE_RETRY_AFTER_MS;
}
