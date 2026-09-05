import type { Classifier } from "../ai/classifier.js";
import type { GmailClient } from "../gmail/client.js";
import {
  fetchProfile,
  headersFromMessage,
  listAllMessageIds,
  fetchMessageMetadata,
  type MessageStub
} from "../gmail/scanner.js";
import { buildNormalizedMessage } from "../gmail/normalize.js";
import { GMAIL_LABELS, hasUnattributedProtectionLabel, isInInbox, isNativeSpam, isRead } from "../gmail/labels.js";
import { findMatchingRuleGroups } from "../rules/matcher.js";
import { evaluateMessagePolicy, POLICY_VERSION, type PolicyThresholds } from "./policy.js";
import { buildRunSummary, type MessageOutcome, type RunSummary } from "../summary/build-summary.js";
import { validateEventCandidate, type ValidatedEvent } from "../calendar/event-policy.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { AssessmentResult, NormalizedMessage, RuleAction } from "./models.js";
import type { RuleGroup } from "./models.js";
import type { Clock } from "./clock.js";

export interface OrchestratorDeps {
  gmailClient: GmailClient;
  classifier: Classifier;
  ruleGroups: readonly RuleGroup[];
  userEmail: string;
  userTimezone: string;
  clock: Clock;
  /**
   * gmailReads bounds concurrent Gmail metadata fetches; aiCalls bounds
   * concurrent classifier calls. These are deliberately separate — Gmail
   * and the AI provider are independent rate-limit domains, so batching
   * AI calls at the same concurrency as Gmail reads would size one
   * provider's in-flight request count off a completely unrelated API's
   * quota characteristics.
   */
  concurrency: { gmailReads: number; aiCalls: number };
  /**
   * Caps the Inbox scan and the native-Spam scan to this many messages
   * each (most recent first — Gmail returns messages.list results newest
   * first when unsorted by a query). Applied before any per-message
   * messages.get call, since that's what actually drives Gmail API quota
   * usage, not just how many list pages get fetched.
   */
  limit?: number;
  policyThresholds?: PolicyThresholds;
  /** Message IDs the app's own ledger has starred/marked-important, for protection detection. */
  appAttributedLabelsByMessageId?: ReadonlyMap<string, ReadonlySet<"STARRED" | "IMPORTANT">>;
}

export interface WorkScanResult {
  summary: RunSummary;
  outcomes: MessageOutcome[];
  historyIdAtSnapshot: string;
  /** Set when --limit capped the Inbox and/or Spam scan; states what was skipped, per CLAUDE.md's "state exactly how many remain" requirement. */
  scanNote: string | null;
}

function dedupeStubs(stubs: readonly MessageStub[]): MessageStub[] {
  const seen = new Map<string, MessageStub>();
  for (const stub of stubs) {
    seen.set(stub.id, stub);
  }
  return [...seen.values()];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Read-only snapshot + normalize + explicit rules + policy pipeline. Safe
 * to call for `--dry-run`: it only reads Gmail and calls the classifier,
 * never mutates Gmail, Calendar, rules, or durable state.
 */
export async function runWorkScan(deps: OrchestratorDeps): Promise<WorkScanResult> {
  const profile = await fetchProfile(deps.gmailClient);

  const [spamResult, inboxResult] = await Promise.all([
    listAllMessageIds(deps.gmailClient, {
      labelIds: [GMAIL_LABELS.spam],
      includeSpamTrash: true,
      ...(deps.limit !== undefined ? { safetyCapCount: deps.limit } : {})
    }),
    listAllMessageIds(deps.gmailClient, {
      labelIds: [GMAIL_LABELS.inbox],
      includeSpamTrash: false,
      ...(deps.limit !== undefined ? { safetyCapCount: deps.limit } : {})
    })
  ]);

  const stubs = dedupeStubs([...spamResult.messages, ...inboxResult.messages]);

  // Phase 1: fetch + normalize + rule-match, batched at gmailReads
  // concurrency. No classifier calls happen here.
  const preprocessed: PreprocessedMessage[] = [];
  for (const batch of chunk(stubs, deps.concurrency.gmailReads)) {
    const batchResults = await Promise.all(
      batch.map((stub) => fetchAndNormalize(stub, deps, profile.emailAddress))
    );
    preprocessed.push(...batchResults);
  }

  // Most recent first: Gmail's own list order is not a documented,
  // guaranteed contract, and this is what actually determines both
  // classification priority (under concurrency, earlier array entries get
  // picked up first) and the "most recent unread" summary section below —
  // so it's made explicit here rather than assumed from the API response.
  preprocessed.sort((a, b) => Number(b.normalized.internalDate) - Number(a.normalized.internalDate));

  // Phase 2: classify only the messages that aren't bypassed by an
  // explicit rule or native spam, at the separate, lower aiCalls
  // concurrency.
  const assessmentResults = await mapWithConcurrency(preprocessed, deps.concurrency.aiCalls, (pre) =>
    pre.bypassed
      ? Promise.resolve(null)
      : deps.classifier.assess(pre.normalized, {
          classifierVersion: "not-configured",
          promptVersion: "not-configured",
          schemaVersion: "not-configured",
          policyVersion: POLICY_VERSION
        })
  );

  // Phase 3: pure policy evaluation + event validation, no I/O.
  const outcomes = preprocessed.map((pre, i) => finalizeOutcome(pre, assessmentResults[i] ?? null, deps));

  const summary = buildRunSummary(inboxResult.messages.length, outcomes);
  return { summary, outcomes, historyIdAtSnapshot: profile.historyId, scanNote: buildScanNote(inboxResult, spamResult) };
}

function buildScanNote(
  inboxResult: { truncated: boolean; messages: readonly unknown[]; estimatedTotal: number | null },
  spamResult: { truncated: boolean; messages: readonly unknown[]; estimatedTotal: number | null }
): string | null {
  const parts: string[] = [];
  if (inboxResult.truncated) {
    const total = inboxResult.estimatedTotal;
    parts.push(
      `Inbox: scanned the ${inboxResult.messages.length} most recent message(s)` +
        (total !== null ? ` of an estimated ~${total} total` : "") +
        "."
    );
  }
  if (spamResult.truncated) {
    const total = spamResult.estimatedTotal;
    parts.push(
      `Spam: scanned the ${spamResult.messages.length} most recent message(s)` +
        (total !== null ? ` of an estimated ~${total} total` : "") +
        "."
    );
  }
  return parts.length > 0 ? `--limit applied. ${parts.join(" ")}` : null;
}

interface PreprocessedMessage {
  stub: MessageStub;
  normalized: NormalizedMessage;
  labelIds: readonly string[];
  nativeSpam: boolean;
  explicitRule: { action: RuleAction; ruleGroupId: string } | null;
  authFailedImportantRule: boolean;
  isProtected: boolean;
  /** True when native spam or an explicit spam rule means the classifier must never be called for this message. */
  bypassed: boolean;
}

async function fetchAndNormalize(
  stub: MessageStub,
  deps: OrchestratorDeps,
  userEmail: string
): Promise<PreprocessedMessage> {
  const raw = await fetchMessageMetadata(deps.gmailClient, stub.id);
  const headers = headersFromMessage(raw);
  const labelIds = raw.labelIds ?? [];

  const normalized = buildNormalizedMessage({
    gmailMessageId: stub.id,
    gmailThreadId: stub.threadId,
    historyId: raw.historyId ?? "0",
    internalDate: raw.internalDate ?? "0",
    labelIds,
    snippet: raw.snippet ?? "",
    headers,
    htmlBody: null,
    plainBody: null,
    userEmail,
    threadHasUserSentMessage: false
  });

  const nativeSpam = isNativeSpam(labelIds);
  const ruleMatches = findMatchingRuleGroups(deps.ruleGroups, normalized);
  const matched = ruleMatches.find((r) => r.result === "matched");
  const explicitRule = matched ? { action: matched.ruleGroup.action, ruleGroupId: matched.ruleGroup.id } : null;
  // A structurally-matching important rule whose stored DKIM/DMARC binding
  // failed to verify must not be silently ignored — that's exactly the
  // spoofed-sender case the binding exists to catch — so it forces Review
  // rather than letting the message fall through to ordinary handling.
  const authFailedImportantRule = ruleMatches.some(
    (r) => r.result === "auth_failed" && r.ruleGroup.action === "important"
  );

  const appAttributed = deps.appAttributedLabelsByMessageId?.get(stub.id) ?? new Set<"STARRED" | "IMPORTANT">();
  const isProtected =
    explicitRule?.action === "important" || hasUnattributedProtectionLabel(labelIds, appAttributed);

  return {
    stub,
    normalized,
    labelIds,
    nativeSpam,
    explicitRule,
    authFailedImportantRule,
    isProtected,
    bypassed: explicitRule?.action === "spam" || nativeSpam
  };
}

function finalizeOutcome(
  pre: PreprocessedMessage,
  assessmentResult: AssessmentResult | null,
  deps: OrchestratorDeps
): MessageOutcome {
  const { stub, normalized, labelIds, nativeSpam, explicitRule, authFailedImportantRule, isProtected } = pre;

  const assessment = assessmentResult?.ok ? assessmentResult.assessment : null;
  const assessmentUnavailable = !pre.bypassed && assessmentResult !== null && !assessmentResult.ok;

  const rawDecision = evaluateMessagePolicy(
    {
      gmailMessageId: stub.id,
      isInInbox: isInInbox(labelIds),
      isRead: isRead(labelIds),
      isNativeSpam: nativeSpam,
      isProtected,
      explicitRule,
      // Authenticated high-risk signal detection requires the real
      // classifier; without it this can only ever gate AI-derived trash,
      // which never fires while AI is not configured.
      hasAuthenticatedHighRiskSignal: false,
      assessment,
      assessmentUnavailable
    },
    deps.policyThresholds
  );

  // The policy only checks the event's confidence and intent — it never
  // validates the date/time shape itself (that's real code's job, not
  // something to trust from a model's output). Any calendar_create action
  // must additionally pass validateEventCandidate before it survives;
  // otherwise it's downgraded to a review item instead of a real Calendar
  // API call with garbage dates.
  let validatedEvent: ValidatedEvent | null = null;
  const calendarAction = rawDecision.actions.find((a) => a.type === "calendar_create");
  let decision = rawDecision;
  if (calendarAction && calendarAction.type === "calendar_create") {
    const validation = validateEventCandidate(calendarAction.event, deps.clock.now(), deps.userTimezone);
    if (validation.ok) {
      validatedEvent = validation.event;
    } else {
      decision = {
        actions: rawDecision.actions.filter((a) => a.type !== "calendar_create"),
        needsReview: true,
        reviewReason: rawDecision.reviewReason ?? `event_validation_failed_${validation.reason}`
      };
    }
  }

  if (authFailedImportantRule) {
    // Surfaces even over an existing review reason (e.g. "assessment
    // unavailable") — a spoofed sender tripping an important-rule auth
    // binding is a more specific, actionable signal than a generic one.
    decision = { ...decision, needsReview: true, reviewReason: "important_rule_auth_failed" };
  }

  return {
    gmailMessageId: stub.id,
    gmailThreadId: stub.threadId,
    subjectForDisplay: normalized.subject || "(no subject)",
    senderForDisplay: normalized.from.displayName ?? normalized.from.address ?? "unknown sender",
    decision,
    bypassReason: explicitRule?.action === "spam" ? "explicit_spam_rule" : nativeSpam ? "native_spam" : explicitRule?.action === "important" ? "explicit_important_rule" : null,
    labelIdsAtSnapshot: labelIds,
    validatedEvent,
    classifierVersion: assessment?.classifierVersion ?? null,
    internalDate: normalized.internalDate,
    isUnread: !isRead(labelIds)
  };
}
