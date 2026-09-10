import { listAllMessageIds } from "./scanner.js";
import { SETTING_KEYS, SettingsRepository } from "../state/repositories/settings.js";
import { GMAIL_LABELS } from "./labels.js";
import type { GmailClient } from "./client.js";
import type { GmailAgentDatabase } from "../state/database.js";

/**
 * The set of thread IDs the user has sent a message on, kept in SQLite and
 * topped up instead of rebuilt.
 *
 * This set gates every AI-derived Trash action (CLAUDE.md's reply
 * protection: a thread the user took part in is never auto-trashed), so it
 * has to be complete before the first message can be trashed. Rebuilding it
 * each run meant fully paginating the SENT label — 500 IDs per request,
 * sequentially — right at the start of the action phase, which is what made
 * runs look like they hung after reading finished.
 *
 * The protection is unchanged; only how the set is obtained is. A cold
 * start still pays for one full pass. After that, `messages.list` returns
 * newest-first, so a run walks pages only until it reaches the newest sent
 * message the previous pass recorded — normally a single page, often zero
 * new threads.
 */
export interface SentThreadIndex {
  threadIds: Set<string>;
  /** True when this run had to build the index from nothing. */
  coldStart: boolean;
  /** Sent messages newly discovered this run. */
  discovered: number;
}

export async function loadSentThreadIndex(
  db: GmailAgentDatabase,
  accountHash: string,
  client: GmailClient,
  nowIso: string,
  onProgress?: (discovered: number) => void
): Promise<SentThreadIndex> {
  const settings = new SettingsRepository(db);
  const knownRows = db
    .prepare("SELECT thread_id FROM sent_threads WHERE account_hash = ?")
    .all(accountHash) as { thread_id: string }[];
  const threadIds = new Set(knownRows.map((row) => row.thread_id));
  const newestSeen = settings.get(accountHash, SETTING_KEYS.sentIndexNewestMessageId);
  const coldStart = newestSeen === null;

  const result = await listAllMessageIds(client, {
    labelIds: [GMAIL_LABELS.sent],
    includeSpamTrash: false,
    ...(newestSeen !== null ? { stopAtMessageId: newestSeen } : {}),
    ...(onProgress ? { onProgress } : {})
  });

  // Written as one transaction with the marker: a partial insert plus an
  // advanced marker would permanently hide the threads that did not make
  // it in, silently weakening the protection on later runs.
  const persist = db.transaction(() => {
    const insert = db.prepare(
      "INSERT INTO sent_threads (account_hash, thread_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
    );
    for (const message of result.messages) {
      insert.run(accountHash, message.threadId);
      threadIds.add(message.threadId);
    }
    // `messages.list` is newest-first, so the first stub of this pass is
    // the new high-water mark. With nothing new, the old mark still holds.
    const newest = result.messages[0]?.id ?? newestSeen;
    if (newest) settings.set(accountHash, SETTING_KEYS.sentIndexNewestMessageId, newest, nowIso);
  });
  persist();

  return { threadIds, coldStart, discovered: result.messages.length };
}
