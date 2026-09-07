/**
 * Fixes a cross-run double-counting bug: without this table, the same
 * message could vote toward a category's MIN_LABEL_BATCH_SIZE threshold
 * more than once if it was reconciled again by a later incremental sync
 * (e.g. because it separately got starred/archived, which generates its
 * own Gmail history event). Each row records that one message has already
 * been counted toward one account's category candidate, so a repeat
 * classification of the same message never inflates the cumulative count
 * a second time. Rows are deleted together with their `label_candidates`
 * row once a category crosses the threshold and the label is created.
 */
export const MIGRATION_004_LABEL_CANDIDATE_VOTES = `
CREATE TABLE label_candidate_votes (
  account_hash TEXT NOT NULL REFERENCES accounts(account_hash),
  normalized_name TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  PRIMARY KEY (account_hash, normalized_name, gmail_message_id)
);
`;
