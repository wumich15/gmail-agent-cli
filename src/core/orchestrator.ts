import type { Classifier } from "../ai/classifier.js";
import type { GmailClient } from "../gmail/client.js";
import {
  fetchProfile,
  fetchInboxMessageCount,
  headersFromMessage,
  listAllMessageIds,
  listHistorySince,
  fetchMessageFull,
  type HistorySyncResult,
  type MailboxProfile,
  type MessageStub
} from "../gmail/scanner.js";
import { buildNormalizedMessage, extractBodyParts } from "../gmail/normalize.js";
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
  /** The user's current custom Gmail label names, passed to the classifier so it prefers reusing one. */
  existingLabels?: readonly string[];
  /**
   * Cumulative counts (from previous runs) of AI-guessed categories that
   * haven't cleared MIN_LABEL_BATCH_SIZE yet, keyed by normalized
   * (lowercased) name. Needed because incremental Gmail history sync
   * means a normal run only ever sees a handful of changed messages, so a
   * brand-new category could otherwise almost never accumulate 10
   * occurrences in any single run — this lets those occurrences
   * accumulate across runs instead. See WorkScanResult.labelCandidateUpdates
   * for what the caller persists back after each run.
   */
  priorLabelCandidateCounts?: ReadonlyMap<string, { displayName: string; count: number }>;
  /**
   * The account's persisted Gmail history marker from the last successful
   * run, if any. When present and still valid, the scan reconciles only
   * the messages `users.history.list` reports as changed since that point
   * instead of re-listing and re-fetching the whole Inbox and Spam label
   * every time — the main lever for staying under Gmail's API quota on
   * repeat runs. Omit or pass null to force a full snapshot (e.g. the
   * account's first-ever run, or `gmail cache`'s explicit full rebaseline).
   */
  historyMarker?: string | null;
}

/**
 * A single AI-guessed category is never enough to create/apply a label on
 * its own — only once at least this many messages in the same run agree on
 * (a case-insensitive form of) the same name does the label actually get
 * created and applied, keeping one-off guesses from cluttering the
 * mailbox with near-duplicate labels.
 */
export const MIN_LABEL_BATCH_SIZE = 10;

/** One category name's cumulative-count bookkeeping to persist after a run — see `priorLabelCandidateCounts`. */
export interface LabelCandidateUpdate {
  normalizedName: string;
  displayName: string;
  /** The new cumulative total (prior persisted count + this run's count), to store verbatim. */
  newCumulativeCount: number;
  /** True once this crossed the threshold and the label was actually applied this run — the caller should clear its stored candidate row rather than keep counting. */
  applied: boolean;
}

export interface WorkScanResult {
  summary: RunSummary;
  outcomes: MessageOutcome[];
  /** The Gmail history ID the caller should persist as this account's new marker once the run's ledger is durable. */
  newHistoryMarker: string;
  /** True when this scan reconciled only changed messages via history.list rather than listing the whole Inbox/Spam. */
  usedIncrementalSync: boolean;
  /** Set when --limit capped the scan, or an incremental scan happened; states what was skipped/reconciled. */
  scanNote: string | null;
  /** Per-category cumulative-count bookkeeping the caller should persist (or clear) after this run — see `OrchestratorDeps.priorLabelCandidateCounts`. */
  labelCandidateUpdates: readonly LabelCandidateUpdate[];
}

export function dedupeStubs(stubs: readonly MessageStub[]): MessageStub[] {
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
 *
 * Picks between a full snapshot and an incremental (history.list-based)
 * scan depending on whether `deps.historyMarker` is present and still
 * valid — see "Incremental synchronization" in CLAUDE.md. History is only
 * ever an optimization: it changes which messages get looked at on a
 * given run, never the policy that decides what happens to them.
 */
export async function runWorkScan(deps: OrchestratorDeps): Promise<WorkScanResult> {
  const profile = await fetchProfile(deps.gmailClient);

  if (deps.historyMarker) {
    const history = await listHistorySince(deps.gmailClient, deps.historyMarker);
    if (!history.expiredMarker) {
      return runIncrementalScan(deps, profile, history);
    }
    // Gmail returned 404 for the stored marker (it expired) — fall through
    // to the fenced full-rescan procedure below, exactly as CLAUDE.md
    // specifies for this case.
  }
  return runFullScan(deps, profile);
}

/** Phase 1: fetch + normalize + rule-match every stub, batched at gmailReads concurrency, sorted most-recent-first. */
async function fetchAndNormalizeAll(
  stubs: readonly MessageStub[],
  deps: OrchestratorDeps,
  userEmail: string
): Promise<PreprocessedMessage[]> {
  const preprocessed: PreprocessedMessage[] = [];
  for (const batch of chunk(stubs, deps.concurrency.gmailReads)) {
    const batchResults = await Promise.all(batch.map((stub) => fetchAndNormalize(stub, deps, userEmail)));
    preprocessed.push(...batchResults);
  }
  // Most recent first: Gmail's own list/history order is not a documented,
  // guaranteed contract, and this is what actually determines both
  // classification priority (under concurrency, earlier array entries get
  // picked up first) and the "most recent unread" summary section below —
  // so it's made explicit here rather than assumed from the API response.
  preprocessed.sort((a, b) => Number(b.normalized.internalDate) - Number(a.normalized.internalDate));
  return preprocessed;
}

interface ClassifyAndFinalizeResult {
  outcomes: MessageOutcome[];
  labelCandidateUpdates: readonly LabelCandidateUpdate[];
}

/** Phases 2-4: classify (bounded at aiCalls concurrency), evaluate policy, then the run-wide label-batch threshold. No further Gmail I/O. */
async function classifyAndFinalize(
  preprocessed: readonly PreprocessedMessage[],
  deps: OrchestratorDeps
): Promise<ClassifyAndFinalizeResult> {
  const assessmentResults = await mapWithConcurrency(preprocessed, deps.concurrency.aiCalls, (pre) =>
    pre.bypassed
      ? Promise.resolve(null)
      : deps.classifier.assess(pre.normalized, {
          classifierVersion: "not-configured",
          promptVersion: "not-configured",
          schemaVersion: "not-configured",
          policyVersion: POLICY_VERSION,
          existingLabels: deps.existingLabels ?? []
        })
  );
  const rawOutcomes = preprocessed.map((pre, i) => finalizeOutcome(pre, assessmentResults[i] ?? null, deps));
  const existingLabelNamesLower = new Set((deps.existingLabels ?? []).map((name) => name.trim().toLowerCase()));
  return applyLabelBatchThreshold(rawOutcomes, existingLabelNamesLower, deps.priorLabelCandidateCounts ?? new Map());
}

async function runFullScan(deps: OrchestratorDeps, profile: MailboxProfile): Promise<WorkScanResult> {
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
  const preprocessed = await fetchAndNormalizeAll(stubs, deps, profile.emailAddress);
  const { outcomes, labelCandidateUpdates } = await classifyAndFinalize(preprocessed, deps);
  const summary = buildRunSummary(inboxResult.messages.length, outcomes);

  // Catches anything that changed while this full snapshot was being
  // listed/fetched, so it isn't silently missed forever by the next
  // incremental run (which starts from the marker persisted below) — see
  // CLAUDE.md's "read historyId before listing... then reconcile every
  // change through the returned ending history ID."
  const postScanHistory = await listHistorySince(deps.gmailClient, profile.historyId);
  const newHistoryMarker = postScanHistory.expiredMarker ? profile.historyId : postScanHistory.endHistoryId;

  return {
    summary,
    outcomes,
    newHistoryMarker,
    usedIncrementalSync: false,
    scanNote: buildScanNote(inboxResult, spamResult),
    labelCandidateUpdates
  };
}

async function runIncrementalScan(
  deps: OrchestratorDeps,
  profile: MailboxProfile,
  history: HistorySyncResult
): Promise<WorkScanResult> {
  const allChanged = [...history.changedMessages.entries()];
  let stubs: MessageStub[] = allChanged.map(([id, threadId]) => ({ id, threadId }));
  let truncationNote: string | null = null;
  if (deps.limit !== undefined && stubs.length > deps.limit) {
    truncationNote = `--limit applied: processing ${deps.limit} of ${stubs.length} changed message(s); the rest will be reconciled on a later run.`;
    stubs = stubs.slice(0, deps.limit);
  }

  const preprocessedAll = await fetchAndNormalizeAll(stubs, deps, profile.emailAddress);
  // Only a message currently in Inbox or native Spam is ever actionable —
  // exactly the same two input streams a full scan lists directly. A
  // message that changed for an unrelated reason (the user archived or
  // trashed it themselves, etc.) simply isn't evaluated, matching how it
  // would never have appeared in a full listAllMessageIds pass either.
  const preprocessed = preprocessedAll.filter((pre) => isInInbox(pre.labelIds) || isNativeSpam(pre.labelIds));

  const { outcomes, labelCandidateUpdates } = await classifyAndFinalize(preprocessed, deps);
  const inboxCountBefore = await fetchInboxMessageCount(deps.gmailClient);
  const summary = buildRunSummary(inboxCountBefore, outcomes);

  const incrementalNote = `Incremental scan: reconciled ${preprocessed.length} changed, currently Inbox/Spam message(s) since the last run (${allChanged.length} total change(s) detected).`;

  return {
    summary,
    outcomes,
    newHistoryMarker: history.endHistoryId,
    usedIncrementalSync: true,
    scanNote: truncationNote ? `${truncationNote} ${incrementalNote}` : incrementalNote,
    labelCandidateUpdates
  };
}

/**
 * Filters out `label` actions produced from an AI-guessed category
 * (reasonCode `ai_category:...`) unless the *cumulative* count for that
 * name (this run's occurrences plus whatever `priorCounts` already
 * accumulated from earlier runs) reaches MIN_LABEL_BATCH_SIZE, or the name
 * already matches one of the account's `existingLabelNamesLower` (a label
 * that already exists needs no threshold at all — applying it to more
 * mail isn't creating clutter, it's just correctly reusing a label that
 * already cleared this bar once). The "Calendar" label added alongside a
 * validated event (`calendar_label:...`) is a deterministic 1:1 link to a
 * real event, not a fuzzy guess, and always passes through untouched.
 * Every surviving category label in a group is normalized to one exact
 * display name so messages that agreed case-insensitively still end up
 * under the exact same Gmail label instead of near-duplicates.
 */
function applyLabelBatchThreshold(
  outcomes: readonly MessageOutcome[],
  existingLabelNamesLower: ReadonlySet<string>,
  priorCounts: ReadonlyMap<string, { displayName: string; count: number }>
): ClassifyAndFinalizeResult {
  const groups = new Map<string, { count: number; displayName: string }>();
  for (const outcome of outcomes) {
    for (const action of outcome.decision.actions) {
      if (action.type === "label" && action.reasonCode.startsWith("ai_category:")) {
        const key = action.labelName.trim().toLowerCase();
        const group = groups.get(key);
        if (group) {
          group.count += 1;
        } else {
          groups.set(key, { count: 1, displayName: action.labelName.trim() });
        }
      }
    }
  }

  const eligibleKeys = new Set<string>();
  const labelCandidateUpdates: LabelCandidateUpdate[] = [];
  for (const [key, group] of groups) {
    if (existingLabelNamesLower.has(key)) {
      eligibleKeys.add(key);
      continue;
    }
    const priorCount = priorCounts.get(key)?.count ?? 0;
    const cumulative = priorCount + group.count;
    const applied = cumulative >= MIN_LABEL_BATCH_SIZE;
    if (applied) {
      eligibleKeys.add(key);
    }
    labelCandidateUpdates.push({
      normalizedName: key,
      displayName: priorCounts.get(key)?.displayName ?? group.displayName,
      newCumulativeCount: cumulative,
      applied
    });
  }

  const outcomesWithThreshold = outcomes.map((outcome) => {
    const actions = outcome.decision.actions
      .filter((action) => {
        if (action.type !== "label" || !action.reasonCode.startsWith("ai_category:")) {
          return true;
        }
        return eligibleKeys.has(action.labelName.trim().toLowerCase());
      })
      .map((action) => {
        if (action.type === "label" && action.reasonCode.startsWith("ai_category:")) {
          const displayName = groups.get(action.labelName.trim().toLowerCase())!.displayName;
          return { ...action, labelName: displayName, reasonCode: `ai_category:${displayName}` };
        }
        return action;
      });
    return { ...outcome, decision: { ...outcome.decision, actions } };
  });

  return { outcomes: outcomesWithThreshold, labelCandidateUpdates };
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
  // format=full costs the same Gmail API quota unit as format=metadata (5
  // units either way), so fetching the body up front — rather than a
  // second round trip only for messages that turn out to need
  // classification — costs no extra requests, just larger responses for
  // the messages that end up bypassed. This is what lets event extraction
  // actually see the message body instead of only Gmail's short snippet.
  const raw = await fetchMessageFull(deps.gmailClient, stub.id);
  const headers = headersFromMessage(raw);
  const labelIds = raw.labelIds ?? [];
  const { plain, html } = extractBodyParts(raw.payload ?? undefined);
  // The freshly-fetched response is the authoritative source for
  // threadId — `stub.threadId` is only ever a placeholder in the
  // incremental-scan path (built from a history record, not a real
  // messages.list/messages.get result) and only a fallback here in case
  // Gmail's response were ever missing it.
  const resolvedStub: MessageStub = { id: stub.id, threadId: raw.threadId ?? stub.threadId };

  const normalized = buildNormalizedMessage({
    gmailMessageId: resolvedStub.id,
    gmailThreadId: resolvedStub.threadId,
    historyId: raw.historyId ?? "0",
    internalDate: raw.internalDate ?? "0",
    labelIds,
    snippet: raw.snippet ?? "",
    headers,
    htmlBody: html,
    plainBody: plain,
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
    stub: resolvedStub,
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

  // A message that actually gets a Calendar event also gets a "Calendar"
  // label and is moved out of the Inbox, regardless of read state — the
  // event itself is now the durable record, so the mail doesn't need to
  // stay in the Inbox to be found again. This never applies to a fuzzy
  // AI-guessed category (see applyLabelBatchThreshold): it's a
  // deterministic 1:1 consequence of a real, validated event.
  if (validatedEvent !== null) {
    const withCalendarLabel = decision.actions.some((a) => a.type === "label" && a.reasonCode === "calendar_label:Calendar")
      ? decision.actions
      : [...decision.actions, { type: "label" as const, reasonCode: "calendar_label:Calendar", labelName: "Calendar" }];
    const withCalendarArchive = withCalendarLabel.some((a) => a.type === "archive")
      ? withCalendarLabel
      : [...withCalendarLabel, { type: "archive" as const, reasonCode: "calendar_archive" }];
    decision = { ...decision, actions: withCalendarArchive };
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
