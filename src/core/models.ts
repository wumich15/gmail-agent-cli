/**
 * Core domain types shared across the pipeline. Policy code depends only on
 * these types, never on Gmail/Calendar/OpenAI/SQLite SDK shapes directly.
 */

export type IanaTimeZone = string;

export interface AccountRecord {
  accountHash: string;
  emailDisplay: string | null;
  timezone: IanaTimeZone;
  historyMarker: string | null;
  setupComplete: boolean;
  automationEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A normalized, bounded view of a Gmail message. Never holds raw HTML. */
export interface NormalizedMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  historyId: string;
  internalDate: string;
  labelIds: readonly string[];
  from: EmailAddress;
  replyTo: EmailAddress | null;
  to: readonly EmailAddress[];
  subject: string;
  dateHeader: string | null;
  messageIdHeader: string | null;
  listId: string | null;
  listUnsubscribeHeader: string | null;
  listUnsubscribePost: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
  authenticationResults: string | null;
  dkimSignature: string | null;
  snippet: string;
  /** Bounded plain-text body, present only when FULL fetch happened. */
  bodyText: string | null;
  bodyTruncated: boolean;
  contentHash: string;
  isFromUser: boolean;
  threadHasUserSentMessage: boolean;
}

export interface EmailAddress {
  raw: string;
  address: string | null;
  displayName: string | null;
}

export const EMAIL_ASSESSMENT_KINDS = [
  "personal_important",
  "personal_routine",
  "transactional_important",
  "automated_low_value",
  "promotion",
  "suspicious",
  "unknown"
] as const;
export type EmailAssessmentKind = (typeof EMAIL_ASSESSMENT_KINDS)[number];

export const REASON_CODES = [
  "human_sender",
  "bulk_headers",
  "marketing_content",
  "user_action_required",
  "direct_question",
  "deadline",
  "security",
  "financial",
  "reservation",
  "receipt",
  "ambiguous"
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const EVENT_INTENTS = ["none", "create", "update", "cancel"] as const;
export type EventIntent = (typeof EVENT_INTENTS)[number];

export interface EventCandidate {
  intent: EventIntent;
  confidence: number;
  title: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  timeZone: IanaTimeZone | null;
  location: string | null;
  sourceEvidence: string | null;
}

export interface EmailAssessment {
  kind: EmailAssessmentKind;
  confidence: number;
  importanceScore: number;
  importanceConfidence: number;
  summary: string;
  reasonCodes: readonly ReasonCode[];
  event: EventCandidate;
  /** Set by the classifier adapter, not the model, for cache/versioning. */
  classifierVersion: string;
  promptVersion: string;
  schemaVersion: string;
}

/** Returned instead of an EmailAssessment when AI cannot produce one. */
export interface AssessmentUnavailable {
  reason: "not_configured" | "refused" | "timeout" | "schema_failure" | "provider_unavailable" | "low_confidence";
  detail: string | null;
}

export type AssessmentResult =
  | { ok: true; assessment: EmailAssessment }
  | { ok: false; unavailable: AssessmentUnavailable };

export type RuleAction = "spam" | "important";
export type MatcherKind = "list_id" | "from_address" | "from_domain" | "subject_prefix";

export interface RuleMatcher {
  kind: MatcherKind;
  normalizedValue: string;
  /** Required for important matchers: aligned DKIM/DMARC binding. */
  authBinding: AuthBinding | null;
}

export interface AuthBinding {
  mechanism: "dkim" | "dmarc";
  domain: string;
}

export interface RuleGroup {
  id: string;
  accountHash: string;
  categoryName: string;
  action: RuleAction;
  enabled: boolean;
  matchers: readonly RuleMatcher[];
  createdAt: string;
  updatedAt: string;
}

export type ActionType =
  | "trash"
  | "archive"
  | "star"
  | "mark_important"
  | "calendar_create"
  | "calendar_update"
  | "calendar_cancel"
  | "unsubscribe";

export type ActionStatus =
  | "planned"
  | "applying"
  | "applied"
  | "failed_retryable"
  | "failed_terminal"
  | "skipped_conflict"
  | "unknown_no_retry";

export interface PlannedAction {
  /** Deterministic key: stable across retries and process restarts. */
  actionKey: string;
  runId: string;
  accountHash: string;
  type: ActionType;
  targetGmailMessageId: string | null;
  targetGmailThreadId: string | null;
  targetCalendarEventId: string | null;
  reasonCode: string;
  beforeStateHash: string | null;
  payloadHash: string;
  status: ActionStatus;
  attemptCount: number;
  errorClass: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunMode = "work" | "spam" | "important" | "dry_run";
export type RunStatus = "running" | "completed" | "partial_failure" | "failed" | "aborted";

export interface RunRecord {
  runId: string;
  accountHash: string;
  mode: RunMode;
  policyVersion: string;
  classifierVersion: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  counters: Record<string, number>;
  errorSummary: string | null;
}

export type UnsubscribeMethod = "https_one_click" | "mailto" | "manual_link";
export type UnsubscribeStatus =
  | "planned"
  | "applying"
  | "accepted"
  | "sent"
  | "manual_required"
  | "unknown_no_retry"
  | "failed";

export interface UnsubscribeAttempt {
  subscriptionKey: string;
  accountHash: string;
  method: UnsubscribeMethod;
  endpointHash: string;
  status: UnsubscribeStatus;
  retryGeneration: number;
  lastAttemptAt: string;
  responseClass: string | null;
}

export interface CalendarLink {
  accountHash: string;
  gmailMessageId: string;
  candidateIndex: number;
  calendarEventId: string;
  payloadHash: string;
  etag: string | null;
  status: "planned" | "applied" | "failed";
  createdAt: string;
}
