/**
 * A durable index of thread IDs the user has sent a message on.
 *
 * Reply protection ("never auto-trash a thread the user took part in")
 * needs this set before any Trash action can proceed, and it was being
 * rebuilt from scratch on every run by paginating the entire SENT label —
 * 500 message IDs per page, sequentially, with no cap. On a mailbox with
 * years of sent mail that is dozens of round trips inserted between "reads
 * finished" and "the first message is trashed", which is exactly where runs
 * appeared to stall.
 *
 * Persisting it makes the cost one-time: later runs walk the newest SENT
 * page(s) only until they reach the newest message the previous pass
 * already recorded. The protection itself is unchanged — the set is still
 * complete, just not re-fetched.
 */
export const MIGRATION_007_SENT_THREAD_INDEX = `
CREATE TABLE IF NOT EXISTS sent_threads (
  account_hash TEXT NOT NULL REFERENCES accounts(account_hash),
  thread_id TEXT NOT NULL,
  PRIMARY KEY (account_hash, thread_id)
) WITHOUT ROWID;
`;
