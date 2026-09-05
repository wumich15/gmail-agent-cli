export const MIGRATION_001_INITIAL_SCHEMA = `
CREATE TABLE accounts (
  account_hash TEXT PRIMARY KEY,
  email_display TEXT,
  timezone TEXT NOT NULL,
  history_marker TEXT,
  setup_complete INTEGER NOT NULL DEFAULT 0,
  automation_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  account_hash TEXT NOT NULL REFERENCES accounts(account_hash),
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  label_snapshot TEXT NOT NULL,
  classifier_version TEXT,
  prompt_version TEXT,
  schema_version TEXT,
  policy_version TEXT,
  assessment_kind TEXT,
  assessment_confidence REAL,
  importance_score REAL,
  importance_confidence REAL,
  reason_codes TEXT,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (account_hash, gmail_message_id)
);

CREATE TABLE rule_groups (
  id TEXT PRIMARY KEY,
  account_hash TEXT NOT NULL REFERENCES accounts(account_hash),
  category_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('spam', 'important')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_hash, category_name)
);

CREATE TABLE rule_matchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_group_id TEXT NOT NULL REFERENCES rule_groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('list_id', 'from_address', 'from_domain', 'subject_prefix')),
  normalized_value TEXT NOT NULL,
  auth_binding_mechanism TEXT CHECK (auth_binding_mechanism IN ('dkim', 'dmarc')),
  auth_binding_domain TEXT,
  provenance TEXT NOT NULL,
  UNIQUE (rule_group_id, kind, normalized_value)
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  account_hash TEXT NOT NULL REFERENCES accounts(account_hash),
  mode TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  classifier_version TEXT,
  prompt_version TEXT,
  schema_version TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  counters TEXT NOT NULL DEFAULT '{}',
  error_summary TEXT
);

CREATE TABLE actions (
  action_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  account_hash TEXT NOT NULL REFERENCES accounts(account_hash),
  type TEXT NOT NULL,
  target_gmail_message_id TEXT,
  target_gmail_thread_id TEXT,
  target_calendar_event_id TEXT,
  reason_code TEXT NOT NULL,
  before_state_hash TEXT,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_class TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_actions_run ON actions(run_id);
CREATE INDEX idx_actions_status ON actions(status);
CREATE INDEX idx_actions_message ON actions(account_hash, target_gmail_message_id);

CREATE TABLE unsubscribe_attempts (
  subscription_key TEXT PRIMARY KEY,
  account_hash TEXT NOT NULL REFERENCES accounts(account_hash),
  method TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  retry_generation INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT NOT NULL,
  response_class TEXT
);

CREATE TABLE calendar_links (
  account_hash TEXT NOT NULL REFERENCES accounts(account_hash),
  gmail_message_id TEXT NOT NULL,
  candidate_index INTEGER NOT NULL DEFAULT 0,
  calendar_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  etag TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_hash, gmail_message_id, candidate_index)
);

CREATE TABLE settings (
  account_hash TEXT NOT NULL REFERENCES accounts(account_hash),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_hash, key)
);
`;
