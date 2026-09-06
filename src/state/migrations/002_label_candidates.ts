export const MIGRATION_002_LABEL_CANDIDATES = `
CREATE TABLE label_candidates (
  account_hash TEXT NOT NULL REFERENCES accounts(account_hash),
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  pending_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_hash, normalized_name)
);
`;
