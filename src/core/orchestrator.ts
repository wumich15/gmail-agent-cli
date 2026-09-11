import type { gmail_v1 } from "googleapis";
import type { Classifier } from "../ai/classifier.js";
import type { GmailClient } from "../gmail/client.js";
import {
  fetchProfile,
  fetchInboxMessageCount,
  fetchThreadHasUserSentMessage,
  headersFromMessage,
  listAllMessageIds,
  listHistorySince,
  fetchMessageFull,
  type HistorySyncResult,
  type MailboxProfile,
  type MessageStub
} from "../gmail/scanner.js";
import { buildNormalizedMessage, extractBodyParts } from "../gmail/normalize.js";
import { GMAIL_LABELS, hasBulkHeaderSignal, isInInbox, isNativeSpam, isRead } from "../gmail/labels.js";
import { findMatchingRuleGroups, normalizeAddress, normalizeListId } from "../rules/matcher.js";
import { evaluateMessagePolicy, POLICY_VERSION, type MessagePolicyInput, type PolicyThresholds } from "./policy.js";
import { hasAuthenticatedHighRiskSignal } from "./high-risk-signal.js";
import { buildRunSummary, type AutomaticSpamRuleCandidate, type MessageOutcome, type RunSummary } from "../summary/build-summary.js";
import { sourceEvidencePresent, validateEventCandidate, type ValidatedEvent } from "../calendar/event-policy.js";
import { mapWithConcurrency } from "./concurrency.js";
import { buildDeterministicSummary } from "../ai/prompt.js";
import type {
  AssessmentResult,
  EmailAssessment,
  EmailAssessmentKind,
  NormalizedMessage,
  ReasonCode,
  RuleAction
} from "./models.js";
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
   * Gmail message IDs that already voted toward a category's cumulative
   * count in an earlier run, keyed by the same normalized (lowercased)
   * name as `priorLabelCandidateCounts`. Without this, a message
   * reconciled again by a later incremental sync (e.g. because it was
   * separately starred, which generates its own Gmail history event)
   * would vote for the same category a second time, inflating the count
   * past what actually reflects distinct messages. See
   * `WorkScanResult.labelCandidateUpdates`'s `newlyVotedMessageIds`.
   */
  priorLabelCandidateVotedMessageIds?: ReadonlyMap<string, ReadonlySet<string>>;
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
  /**
   * The exact version identifiers the currently-resolved classifier would
   * produce (see `ai/resolve-classifier.ts`'s `ResolvedClassifier`).
   * Required for `cachedAssessments` to mean anything: a cached row's
   * stored versions must match these exactly, or the cache is for a
   * different model/prompt/schema and must not be reused. Defaults to
   * `"not-configured"` for all three when omitted, matching
   * `NotConfiguredClassifier`'s placeholder and guaranteeing no accidental
   * cache hit when nothing meaningful is configured.
   */
  classifierVersion?: string;
  promptVersion?: string;
  schemaVersion?: string;
  /**
   * Cache-only policy/context version. Callers may extend POLICY_VERSION
   * with hashes of enabled local rules and existing-label context so a
   * local configuration change queues otherwise-unchanged cached mail for
   * targeted re-evaluation. Defaults to POLICY_VERSION for direct users.
   */
  cachePolicyVersion?: string;
  /**
   * Previously-computed, still-valid assessments for messages this account
   * has already classified, keyed by Gmail message ID — see
   * `CachedAssessmentSnapshot`. When a message's current content hash and
   * this run's classifier/prompt/schema/policy versions all match a cached
   * entry exactly, the AI call is skipped entirely and the cached
   * assessment is reused verbatim: nothing about the classification inputs
   * changed, so a fresh call would almost certainly reproduce the same
   * verdict anyway. This is the concrete mechanism behind CLAUDE.md's
   * "Cache assessments using content and version hashes" requirement,
   * which `gmail cache`'s snapshot alone does not implement on its own —
   * only `gmail work` actually consults and refreshes this cache (see
   * `WorkScanResult.messageCacheUpdates`).
   */
  cachedAssessments?: ReadonlyMap<string, CachedAssessmentSnapshot>;
  /**
   * Locally cached messages that still need one live hydration/evaluation
   * pass (for example rows written by `gmail cache`, which deliberately
   * does not call the classifier, or rows whose model/prompt/schema/policy
   * version is stale). These are reconciled alongside Gmail history
   * changes, so advancing the history marker during `gmail cache` cannot
   * make the cached backlog permanently invisible to `gmail work`.
   */
  cachedBacklogStubs?: readonly MessageStub[];
  /**
   * Thread IDs discovered from one paginated `messages.list(labelIds=[SENT])`
   * index. When supplied, reply protection is answered locally instead of
   * issuing a 40-unit `threads.get` for every Trash candidate.
   */
  sentThreadIds?: ReadonlySet<string>;
  loadSentThreadIds?: () => Promise<ReadonlySet<string>>;
  /** True when the Sent index could not be built; Trash must be held for review. */
  sentThreadIndexUnavailable?: boolean;
  /**
   * Work from what is already cached instead of asking Gmail what changed.
   *
   * When the local cache was refreshed moments ago — by `gmail cache`, or
   * by a `gmail view` session that has been syncing itself — a fresh
   * `users.history.list` pass is very likely to report nothing new, so the
   * caller can skip discovery entirely and spend the run on the cached
   * backlog it already knows needs evaluating.
   *
   * This never skips *hydration*: message bodies are deliberately not
   * persisted, so each queued message is still fetched live before it is
   * classified. And because nothing was discovered, the history marker is
   * left exactly where it was, so the next ordinary run still picks up
   * every change that arrived in the meantime. Ignored when there is no
   * marker or no cached backlog to work on.
   */
  preferCache?: boolean;
  /** Optional progress sink used by the CLI; omitted by library/test callers. */
  progress?: ClassifierProgress;
  readProgress?: ReadProgress;
}

export interface ReadProgress {
  onPhase(phase: "preparing" | "discovering" | "hydrating" | "reconciling" | "applying", total?: number): void;
  onProgress(completed: number, total?: number, failed?: number): void;
  onFinish(success?: boolean): void;
}

export interface ClassifierProgress {
  onStart(total: number): void;
  onProgress(completed: number, total: number): void;
  onFinish(): void;
}

/** See `OrchestratorDeps.cachedAssessments`. Mirrors the non-verbatim projection `state/repositories/messages.ts` persists — never body text, summaries, or AI sourceEvidence. */
export interface CachedAssessmentSnapshot {
  contentHash: string;
  classifierVersion: string;
  promptVersion: string;
  schemaVersion: string;
  policyVersion: string;
  kind: EmailAssessmentKind;
  confidence: number;
  importanceScore: number;
  importanceConfidence: number;
  reasonCodes: readonly ReasonCode[];
  category: string | null;
}

/** One message's up-to-date cache row to persist after a run — see `OrchestratorDeps.cachedAssessments`. */
export interface MessageCacheUpdate {
  gmailMessageId: string;
  gmailThreadId: string;
  contentHash: string;
  labelSnapshot: readonly string[];
  /** Null when this message never reached the classifier (bypassed by an explicit rule or native spam) — nothing to cache. */
  assessment: CachedAssessmentSnapshot | null;
  /** Whether the fresh assessment contained any event intent; event payload/evidence itself is deliberately never cached. */
  assessmentHadEvent: boolean | null;
  /**
   * Versions under which this row was fully evaluated, even when no AI
   * assessment exists (deterministic spam/rule bypass, or rules-only mode).
   * Keeping these separate from `assessment` prevents such rows from
   * being mistaken for never-processed cache placeholders forever.
   */
  evaluatedVersions: {
    classifierVersion: string;
    promptVersion: string;
    schemaVersion: string;
    policyVersion: string;
  } | null;
  subject: string | null;
  senderDisplay: string | null;
  internalDate: string;
}

/**
 * A single AI-guessed category is never enough to create/apply a label on
 * its own — only once at least this many messages in the same run agree on
 * (a case-insensitive form of) the same name does the label actually get
 * created and applied, keeping one-off guesses from cluttering the
 * mailbox with near-duplicate labels.
 */
export const MIN_LABEL_BATCH_SIZE = 10;

/** Three unread messages from the same narrow bulk identity are enough to persist a spam rule. */
export const MIN_AUTOMATIC_SPAM_RULE_MESSAGES = 3;
/** Old routine mail is only auto-trashed after a long retention window. */
const OLD_LOW_VALUE_DAYS = 90;

/** One category name's cumulative-count bookkeeping to persist after a run — see `priorLabelCandidateCounts`. */
export interface LabelCandidateUpdate {
  normalizedName: string;
  displayName: string;
  /** The new cumulative total (prior persisted count + this run's count), to store verbatim. */
  newCumulativeCount: number;
  /** True once this crossed the threshold and the label was actually applied this run — the caller should clear its stored candidate row rather than keep counting. */
  applied: boolean;
  /** Message IDs that voted for this category in THIS run (i.e. weren't already counted in a previous run) — the caller should persist these so a later run never counts them again. Empty/irrelevant once `applied` is true, since the candidate row (and its votes) are cleared instead. */
  newlyVotedMessageIds: readonly string[];
}

export interface WorkScanResult {
  summary: RunSummary;
  outcomes: MessageOutcome[];
  /** The Gmail history ID the caller should persist as this account's new marker once the run's ledger is durable. */
  /** Null when a --limit made this scan incomplete; callers must clear the marker rather than skip omitted mail. */
  newHistoryMarker: string | null;
  /** True when this scan reconciled only changed messages via history.list rather than listing the whole Inbox/Spam. */
  usedIncrementalSync: boolean;
  /** Set when --limit capped the scan, or an incremental scan happened; states what was skipped/reconciled. */
  scanNote: string | null;
  /** Per-category cumulative-count bookkeeping the caller should persist (or clear) after this run — see `OrchestratorDeps.priorLabelCandidateCounts`. */
  labelCandidateUpdates: readonly LabelCandidateUpdate[];
  /** Every scanned message's up-to-date cache row — see `OrchestratorDeps.cachedAssessments`. The caller persists these (outside `--dry-run`) so a later run can skip re-classifying unchanged content. */
  messageCacheUpdates: readonly MessageCacheUpdate[];
  /** Content-free timing/call counters used to distinguish Gmail latency, AI latency, retries, and cache effectiveness. */
  diagnostics: ScanDiagnostics;
  /** Cached rows proven deleted or no longer in Inbox/Spam by incremental reconciliation. */
  cacheEvictionMessageIds: readonly string[];
}

export interface ScanDiagnostics {
  totalMs: number;
  profileMs: number;
  historyMs: number;
  listingMs: number;
  messageFetchMs: number;
  classificationMs: number;
  policyMs: number;
  inboxCountMs: number;
  messagesFetched: number;
  messagesFailed: number;
  classifierCalls: number;
  assessmentCacheHits: number;
  threadChecks: number;
  threadCheckFailures: number;
  cachedBacklogQueued: number;
  /** Epoch-millisecond bounds of successfully hydrated messages, for diagnosing a stale/recent-mail gap. */
  oldestMessageInternalDate: string | null;
  newestMessageInternalDate: string | null;
}

function emptyScanDiagnostics(): ScanDiagnostics {
  return {
    totalMs: 0,
    profileMs: 0,
    historyMs: 0,
    listingMs: 0,
    messageFetchMs: 0,
    classificationMs: 0,
    policyMs: 0,
    inboxCountMs: 0,
    messagesFetched: 0,
    messagesFailed: 0,
    classifierCalls: 0,
    assessmentCacheHits: 0,
    threadChecks: 0,
    threadCheckFailures: 0,
    cachedBacklogQueued: 0,
    oldestMessageInternalDate: null,
    newestMessageInternalDate: null
  };
}

function recordMessageDateBounds(
  diagnostics: ScanDiagnostics,
  messages: readonly PreprocessedMessage[]
): void {
  const dates = messages
    .map((message) => message.normalized.internalDate)
    .filter((date) => /^\d+$/.test(date));
  if (dates.length === 0) return;
  diagnostics.oldestMessageInternalDate = dates.reduce((oldest, date) =>
    BigInt(date) < BigInt(oldest) ? date : oldest
  );
  diagnostics.newestMessageInternalDate = dates.reduce((newest, date) =>
    BigInt(date) > BigInt(newest) ? date : newest
  );
}

export function dedupeStubs(stubs: readonly MessageStub[]): MessageStub[] {
  const seen = new Map<string, MessageStub>();
  for (const stub of stubs) {
    seen.set(stub.id, stub);
  }
  return [...seen.values()];
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
  const totalStartedAt = performance.now();
  const diagnostics = emptyScanDiagnostics();
  deps.readProgress?.onPhase("discovering");
  if (deps.historyMarker && deps.preferCache && (deps.cachedBacklogStubs?.length ?? 0) > 0) {
    // Cache-first: no history request at all. The marker is carried
    // through unchanged as this scan's end marker, so skipping discovery
    // now cannot make the changes it would have found invisible later.
    //
    // The signed-in address normally comes from the account row; fetching
    // the profile is only a fallback for the rare case where it is absent,
    // since normalization needs it to tell the user's own mail apart.
    let userEmail = deps.userEmail;
    if (userEmail.trim().length === 0) {
      const profileStartedAt = performance.now();
      userEmail = (await fetchProfile(deps.gmailClient)).emailAddress;
      diagnostics.profileMs = performance.now() - profileStartedAt;
    }
    const result = await runIncrementalScan(
      deps,
      userEmail,
      {
        changedMessages: new Map(),
        deletedMessageIds: new Set(),
        endHistoryId: deps.historyMarker,
        expiredMarker: false
      },
      diagnostics
    );
    diagnostics.totalMs = performance.now() - totalStartedAt;
    return result;
  }
  if (deps.historyMarker) {
    const historyStartedAt = performance.now();
    const history = await listHistorySince(deps.gmailClient, deps.historyMarker,
      (count) => deps.readProgress?.onProgress(count));
    diagnostics.historyMs = performance.now() - historyStartedAt;
    if (!history.expiredMarker) {
      // A valid incremental run already has the signed-in address from the
      // account row. Avoid an otherwise redundant getProfile round trip on
      // the hottest (and most common) path.
      let userEmail = deps.userEmail;
      if (userEmail.trim().length === 0) {
        const profileStartedAt = performance.now();
        userEmail = (await fetchProfile(deps.gmailClient)).emailAddress;
        diagnostics.profileMs = performance.now() - profileStartedAt;
      }
      const result = await runIncrementalScan(deps, userEmail, history, diagnostics);
      diagnostics.totalMs = performance.now() - totalStartedAt;
      return result;
    }
    // Gmail returned 404 for the stored marker (it expired) — fall through
    // to the fenced full-rescan procedure below, exactly as CLAUDE.md
    // specifies for this case.
  }
  const profileStartedAt = performance.now();
  const profile = await fetchProfile(deps.gmailClient);
  diagnostics.profileMs = performance.now() - profileStartedAt;
  const result = await runFullScan(deps, profile, diagnostics);
  diagnostics.totalMs = performance.now() - totalStartedAt;
  return result;
}

/** Phase 1: fetch + normalize + rule-match every stub through a bounded worker pool, sorted most-recent-first. */
async function fetchAndNormalizeAll(
  stubs: readonly MessageStub[],
  deps: OrchestratorDeps,
  userEmail: string
): Promise<{ messages: PreprocessedMessage[]; failed: MessageOutcome[] }> {
  const messages: PreprocessedMessage[] = [];
  const failed: MessageOutcome[] = [];
  let completed = 0;
  deps.readProgress?.onPhase("hydrating", stubs.length);
  const record = (stub: MessageStub, raw: gmail_v1.Schema$Message | null): void => {
    try {
      if (raw === null) throw new Error("Message read failed.");
      messages.push(normalizeFetchedMessage(stub, deps, userEmail, raw));
    } catch {
      failed.push({
        gmailMessageId: stub.id, gmailThreadId: stub.threadId,
        subjectForDisplay: "Message could not be read", senderForDisplay: "",
        decision: { actions: [], needsReview: true, reviewReason: "gmail_read_failed" },
        bypassReason: null, labelIdsAtSnapshot: [], validatedEvent: null,
        classifierVersion: null, internalDate: "0", isUnread: false
      });
    }
    deps.readProgress?.onProgress(++completed, stubs.length, failed.length);
  };
  try {
    await mapWithConcurrency(stubs, deps.concurrency.gmailReads, async (stub) => {
      let raw: gmail_v1.Schema$Message | null;
      try { raw = await fetchMessageFull(deps.gmailClient, stub.id); }
      catch { raw = null; }
      record(stub, raw);
    });
  } finally {
    deps.readProgress?.onFinish(completed === stubs.length && failed.length === 0);
  }
  messages.sort((a, b) => Number(b.normalized.internalDate) - Number(a.normalized.internalDate));
  return { messages, failed };
}

interface ClassifyAndFinalizeResult {
  outcomes: MessageOutcome[];
  labelCandidateUpdates: readonly LabelCandidateUpdate[];
  messageCacheUpdates: readonly MessageCacheUpdate[];
}

/**
 * Phases 2-4: classify (bounded at aiCalls concurrency, skipping the AI
 * call entirely on a cache hit — see `OrchestratorDeps.cachedAssessments`),
 * evaluate policy (deferring the thread-reply-protection Gmail call to
 * only the messages actually about to be trashed — see `finalizeOutcome`),
 * then the run-wide label-batch threshold.
 */
async function classifyAndFinalize(
  preprocessed: readonly PreprocessedMessage[],
  deps: OrchestratorDeps,
  diagnostics: ScanDiagnostics
): Promise<ClassifyAndFinalizeResult> {
  const classifierVersion = deps.classifierVersion ?? "not-configured";
  const promptVersion = deps.promptVersion ?? "not-configured";
  const schemaVersion = deps.schemaVersion ?? "not-configured";
  const cachePolicyVersion = deps.cachePolicyVersion ?? POLICY_VERSION;

  const classificationStartedAt = performance.now();
  const progressTotal = preprocessed.length;
  let progressCompleted = 0;
  deps.progress?.onStart(progressTotal);
  let assessmentResults: (AssessmentResult | null)[];
  try {
    assessmentResults = await mapWithConcurrency(preprocessed, deps.concurrency.aiCalls, async (pre) => {
      let result: AssessmentResult | null;
      if (pre.bypassed) {
        result = null;
      } else {
        const cached = deps.cachedAssessments?.get(pre.stub.id);
        if (
          cached &&
          cached.contentHash === pre.normalized.contentHash &&
          cached.classifierVersion === classifierVersion &&
          cached.promptVersion === promptVersion &&
          cached.schemaVersion === schemaVersion &&
          cached.policyVersion === cachePolicyVersion
        ) {
          diagnostics.assessmentCacheHits += 1;
          // Nothing about the classification inputs changed since this exact
          // assessment was produced (identical content, identical
          // classifier/prompt/schema/policy versions) — a fresh AI call would
          // almost certainly reproduce the same verdict, so skip it entirely.
          // This is what makes a later `gmail work` run actually use `gmail
          // cache`'s (and a prior run's own) stored data instead of
          // re-classifying every changed message from scratch.
          result = { ok: true, assessment: reconstructAssessment(cached, pre.normalized) };
        } else {
          diagnostics.classifierCalls += 1;
          result = await deps.classifier.assess(pre.normalized, {
            classifierVersion,
            promptVersion,
            schemaVersion,
            policyVersion: POLICY_VERSION,
            existingLabels: deps.existingLabels ?? []
          });
        }
      }
      progressCompleted += 1;
      deps.progress?.onProgress(progressCompleted, progressTotal);
      return result;
    });
  } finally {
    deps.progress?.onFinish();
  }
  diagnostics.classificationMs += performance.now() - classificationStartedAt;

  // Bounded at gmailReads concurrency: most messages need no extra Gmail
  // call at all (see finalizeOutcome's deferred thread-protection check),
  // but this still caps how many can be in flight at once for the ones
  // that do.
  const threadSentCache = new Map<string, Promise<boolean>>();
  const policyStartedAt = performance.now();
  const rawOutcomes = await mapWithConcurrency(preprocessed, deps.concurrency.gmailReads, (pre, i) =>
    finalizeOutcome(pre, assessmentResults[i] ?? null, deps, threadSentCache, diagnostics)
  );
  const existingLabelNamesLower = new Set((deps.existingLabels ?? []).map((name) => name.trim().toLowerCase()));
  const { outcomes, labelCandidateUpdates } = applyLabelBatchThreshold(
    rawOutcomes,
    existingLabelNamesLower,
    deps.priorLabelCandidateCounts ?? new Map(),
    deps.priorLabelCandidateVotedMessageIds ?? new Map()
  );
  diagnostics.policyMs += performance.now() - policyStartedAt;
  return {
    outcomes,
    labelCandidateUpdates,
    messageCacheUpdates: buildMessageCacheUpdates(preprocessed, assessmentResults, {
      classifierVersion,
      promptVersion,
      schemaVersion,
      policyVersion: cachePolicyVersion
    })
  };
}

/**
 * One up-to-date cache row per scanned message, built from the RAW
 * (pre-label-threshold) assessment so a message whose category didn't
 * cross this run's batch threshold still gets its actual proposed category
 * persisted — a later run reconstructing this assessment from cache must
 * see the same category it would have gotten from a fresh AI call, so it
 * can keep contributing votes toward the threshold exactly as before.
 */
function buildMessageCacheUpdates(
  preprocessed: readonly PreprocessedMessage[],
  assessmentResults: readonly (AssessmentResult | null)[],
  currentVersions: NonNullable<MessageCacheUpdate["evaluatedVersions"]>
): MessageCacheUpdate[] {
  return preprocessed.map((pre, i) => {
    const result = assessmentResults[i] ?? null;
    const assessment = result?.ok ? result.assessment : null;
    // Provider/network/schema failures remain eligible for retry on the
    // next run. A deterministic bypass or deliberately unconfigured AI is
    // nevertheless a complete evaluation under the current setup and must
    // not be hydrated on every invocation forever.
    const evaluationCompleted =
      pre.bypassed || assessment !== null || (result !== null && !result.ok && result.unavailable.reason === "not_configured");
    return {
      gmailMessageId: pre.stub.id,
      gmailThreadId: pre.stub.threadId,
      contentHash: pre.normalized.contentHash,
      labelSnapshot: pre.labelIds,
      assessment: assessment
        ? {
            contentHash: pre.normalized.contentHash,
            classifierVersion: assessment.classifierVersion,
            promptVersion: assessment.promptVersion,
            schemaVersion: assessment.schemaVersion,
            policyVersion: POLICY_VERSION,
            kind: assessment.kind,
            confidence: assessment.confidence,
            importanceScore: assessment.importanceScore,
            importanceConfidence: assessment.importanceConfidence,
            reasonCodes: assessment.reasonCodes,
            category: assessment.category
          }
        : null,
      assessmentHadEvent: assessment === null ? null : assessment.event.intent !== "none",
      evaluatedVersions: evaluationCompleted ? currentVersions : null,
      subject: pre.normalized.subject || null,
      senderDisplay: pre.normalized.from.displayName ?? pre.normalized.from.address,
      internalDate: pre.normalized.internalDate
    };
  });
}

/** Rebuilds a full internal EmailAssessment from a cached row, with no AI call. `event` is always reconstructed as absent: a validated Calendar event already moved its message out of Inbox (so it can't reappear here), and a message that had no event before a content-identical reclassification still has none now. `summary` is recomputed fresh (cheap, deterministic, no AI) since it's never persisted verbatim. */
function reconstructAssessment(cached: CachedAssessmentSnapshot, message: NormalizedMessage): EmailAssessment {
  return {
    kind: cached.kind,
    confidence: cached.confidence,
    importanceScore: cached.importanceScore,
    importanceConfidence: cached.importanceConfidence,
    summary: buildDeterministicSummary(message),
    reasonCodes: cached.reasonCodes,
    event: {
      intent: "none",
      confidence: 0,
      title: null,
      start: null,
      end: null,
      allDay: false,
      timeZone: null,
      location: null,
      sourceEvidence: null
    },
    category: cached.category,
    classifierVersion: cached.classifierVersion,
    promptVersion: cached.promptVersion,
    schemaVersion: cached.schemaVersion
  };
}

/** Reuse the pre-scan fence; changes during hydration remain pending for the next run. */
export function resolvePostScanHistoryMarker(_client: GmailClient, fenceHistoryId: string): Promise<string> {
  // Persist the fence already read before listing. A second history call
  // cannot advance it without hydrating those changes; the next incremental
  // run reconciles them anyway, so avoid that redundant request entirely.
  return Promise.resolve(fenceHistoryId);
}

async function runFullScan(
  deps: OrchestratorDeps,
  profile: MailboxProfile,
  diagnostics: ScanDiagnostics
): Promise<WorkScanResult> {
  deps.readProgress?.onPhase("discovering");
  const discovered = [0, 0];
  const reportDiscovery = (index: number, count: number): void => {
    discovered[index] = count;
    deps.readProgress?.onProgress(discovered[0]! + discovered[1]!);
  };
  const listingStartedAt = performance.now();
  const [spamResult, inboxResult] = await Promise.all([
    listAllMessageIds(deps.gmailClient, {
      labelIds: [GMAIL_LABELS.spam],
      includeSpamTrash: true,
      onProgress: (count) => reportDiscovery(0, count),
      ...(deps.limit !== undefined ? { safetyCapCount: deps.limit } : {})
    }),
    listAllMessageIds(deps.gmailClient, {
      labelIds: [GMAIL_LABELS.inbox],
      includeSpamTrash: false,
      onProgress: (count) => reportDiscovery(1, count),
      ...(deps.limit !== undefined ? { safetyCapCount: deps.limit } : {})
    })
  ]);
  diagnostics.listingMs = performance.now() - listingStartedAt;

  const stubs = dedupeStubs([...spamResult.messages, ...inboxResult.messages]);
  const fetchStartedAt = performance.now();
  const { messages: fetched, failed } = await fetchAndNormalizeAll(stubs, deps, profile.emailAddress);
  recordMessageDateBounds(diagnostics, fetched);
  const preprocessed = fetched.filter((pre) => isInInbox(pre.labelIds) || isNativeSpam(pre.labelIds));
  diagnostics.messageFetchMs = performance.now() - fetchStartedAt;
  diagnostics.messagesFetched = stubs.length - failed.length;
  diagnostics.messagesFailed = failed.length;
  const { outcomes, labelCandidateUpdates, messageCacheUpdates } = await classifyAndFinalize(
    preprocessed,
    deps,
    diagnostics
  );
  outcomes.push(...failed);
  const summary = buildRunSummary(inboxResult.messages.length, outcomes);
  summary.failureCount = failed.length;

  // Catches anything that changed while this full snapshot was being
  // listed/fetched, so it isn't silently missed forever by the next
  // incremental run (which starts from the marker persisted below) — see
  // CLAUDE.md's "read historyId before listing... then reconcile every
  // change through the returned ending history ID."
  const snapshotTruncated = inboxResult.truncated || spamResult.truncated;
  let newHistoryMarker: string | null = null;
  if (!snapshotTruncated && failed.length === 0) {
    deps.readProgress?.onPhase("reconciling");
    const historyStartedAt = performance.now();
    newHistoryMarker = await resolvePostScanHistoryMarker(deps.gmailClient, profile.historyId);
    diagnostics.historyMs += performance.now() - historyStartedAt;
    deps.readProgress?.onFinish();
  }

  return {
    summary,
    outcomes,
    newHistoryMarker,
    usedIncrementalSync: false,
    scanNote: buildScanNote(inboxResult, spamResult),
    labelCandidateUpdates,
    messageCacheUpdates,
    diagnostics,
    cacheEvictionMessageIds: fetched.filter((pre) => !isInInbox(pre.labelIds) && !isNativeSpam(pre.labelIds)).map((pre) => pre.stub.id)
  };
}

async function runIncrementalScan(
  deps: OrchestratorDeps,
  userEmail: string,
  history: HistorySyncResult,
  diagnostics: ScanDiagnostics
): Promise<WorkScanResult> {
  const allChanged = [...history.changedMessages.entries()];
  // History is authoritative when the same ID appears in both sources.
  // A deletion is authoritative too: never resurrect a locally cached row
  // that Gmail says no longer exists.
  const workById = new Map<string, MessageStub>();
  for (const cached of deps.cachedBacklogStubs ?? []) {
    if (!history.deletedMessageIds.has(cached.id)) {
      workById.set(cached.id, cached);
    }
  }
  for (const [id, threadId] of allChanged) {
    workById.set(id, { id, threadId });
  }
  diagnostics.cachedBacklogQueued = [...workById.keys()].filter((id) => !history.changedMessages.has(id)).length;
  let stubs = [...workById.values()];
  let truncationNote: string | null = null;
  if (deps.limit !== undefined && stubs.length > deps.limit) {
    truncationNote = `--limit applied: processing ${deps.limit} of ${stubs.length} queued message(s); the history baseline will be cleared so an uncapped later run can safely recover the rest.`;
    stubs = stubs.slice(0, deps.limit);
  }

  const fetchStartedAt = performance.now();
  const { messages: preprocessedAll, failed } = await fetchAndNormalizeAll(stubs, deps, userEmail);
  recordMessageDateBounds(diagnostics, preprocessedAll);
  diagnostics.messageFetchMs = performance.now() - fetchStartedAt;
  diagnostics.messagesFetched = stubs.length - failed.length;
  diagnostics.messagesFailed = failed.length;
  // Only a message currently in Inbox or native Spam is ever actionable —
  // exactly the same two input streams a full scan lists directly. A
  // message that changed for an unrelated reason (the user archived or
  // trashed it themselves, etc.) simply isn't evaluated, matching how it
  // would never have appeared in a full listAllMessageIds pass either.
  const preprocessed = preprocessedAll.filter((pre) => isInInbox(pre.labelIds) || isNativeSpam(pre.labelIds));
  const inactiveMessageIds = preprocessedAll
    .filter((pre) => !isInInbox(pre.labelIds) && !isNativeSpam(pre.labelIds))
    .map((pre) => pre.stub.id);

  const { outcomes, labelCandidateUpdates, messageCacheUpdates } = await classifyAndFinalize(
    preprocessed,
    deps,
    diagnostics
  );
  deps.readProgress?.onPhase("reconciling");
  const inboxCountStartedAt = performance.now();
  const inboxCountBefore = await fetchInboxMessageCount(deps.gmailClient);
  diagnostics.inboxCountMs = performance.now() - inboxCountStartedAt;
  deps.readProgress?.onFinish(failed.length === 0);
  outcomes.push(...failed);
  const summary = buildRunSummary(inboxCountBefore, outcomes);
  summary.failureCount = failed.length;

  const cachedBacklogCount = stubs.filter((stub) => !history.changedMessages.has(stub.id)).length;
  const incrementalNote = deps.preferCache
    ? `Cache-first scan: reconciled ${preprocessed.length} currently Inbox/Spam message(s) from ` +
      `${cachedBacklogCount} cached message(s); Gmail was not asked what changed, so the next run still will.`
    : `Incremental scan: reconciled ${preprocessed.length} currently Inbox/Spam message(s) ` +
      `(${allChanged.length} Gmail change(s), ${cachedBacklogCount} cached backlog message(s)).`;

  return {
    summary,
    outcomes,
    // Advancing to history.endHistoryId after slicing the work list would
    // permanently discard the omitted changes despite the old note saying
    // they would be reconciled later. Returning null earns no new marker;
    // the caller keeps the existing one, so the omitted changes are replayed
    // from where the account already was rather than costing a full rescan.
    newHistoryMarker: truncationNote !== null ? null : failed.length > 0 ? deps.historyMarker ?? null : history.endHistoryId,
    usedIncrementalSync: true,
    scanNote: truncationNote ? `${truncationNote} ${incrementalNote}` : incrementalNote,
    labelCandidateUpdates,
    messageCacheUpdates,
    diagnostics,
    cacheEvictionMessageIds: [...new Set([...history.deletedMessageIds, ...inactiveMessageIds])]
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
 *
 * Counting is deduplicated by Gmail message ID against `priorVotedMessageIds`
 * (messages that already voted for this category in an earlier run): a
 * message reconciled again by a later incremental sync — e.g. because it
 * was separately starred, which generates its own Gmail history event —
 * must not vote for the same category a second time, or a handful of
 * distinct messages could spuriously inflate the cumulative count past
 * MIN_LABEL_BATCH_SIZE.
 */
interface LabelThresholdResult {
  outcomes: MessageOutcome[];
  labelCandidateUpdates: readonly LabelCandidateUpdate[];
}

function applyLabelBatchThreshold(
  outcomes: readonly MessageOutcome[],
  existingLabelNamesLower: ReadonlySet<string>,
  priorCounts: ReadonlyMap<string, { displayName: string; count: number }>,
  priorVotedMessageIds: ReadonlyMap<string, ReadonlySet<string>>
): LabelThresholdResult {
  const groups = new Map<string, { newMessageIds: Set<string>; displayName: string }>();
  for (const outcome of outcomes) {
    for (const action of outcome.decision.actions) {
      if (action.type === "label" && action.reasonCode.startsWith("ai_category:")) {
        const key = action.labelName.trim().toLowerCase();
        const alreadyVoted = priorVotedMessageIds.get(key)?.has(outcome.gmailMessageId) ?? false;
        if (alreadyVoted) {
          continue;
        }
        const group = groups.get(key);
        if (group) {
          group.newMessageIds.add(outcome.gmailMessageId);
        } else {
          groups.set(key, { newMessageIds: new Set([outcome.gmailMessageId]), displayName: action.labelName.trim() });
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
    const cumulative = priorCount + group.newMessageIds.size;
    const applied = cumulative >= MIN_LABEL_BATCH_SIZE;
    if (applied) {
      eligibleKeys.add(key);
    }
    labelCandidateUpdates.push({
      normalizedName: key,
      displayName: priorCounts.get(key)?.displayName ?? group.displayName,
      newCumulativeCount: cumulative,
      applied,
      newlyVotedMessageIds: [...group.newMessageIds]
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
  /** True when native spam or an explicit spam rule means the classifier must never be called for this message. */
  bypassed: boolean;
}

function normalizeFetchedMessage(
  stub: MessageStub, deps: OrchestratorDeps, userEmail: string, raw: gmail_v1.Schema$Message
): PreprocessedMessage {
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
    // Real thread-reply status is resolved lazily in finalizeOutcome, only
    // for a message that's actually about to be trashed — see that function's
    // content-protection logic. This placeholder mirrors every
    // other call site that builds a NormalizedMessage outside this
    // pipeline (view.ts, cache.ts, spam.ts, important.ts).
    threadHasUserSentMessage: false
  });

  const nativeSpam = isNativeSpam(labelIds);
  const ruleMatches = findMatchingRuleGroups(deps.ruleGroups, normalized);
  // An explicit spam rule is a direct user instruction and wins an overlap
  // with an older important rule. `gmail add spam` is the deliberate escape
  // hatch for correcting an over-broad protection rule.
  const matched =
    ruleMatches.find((r) => r.result === "matched" && r.ruleGroup.action === "spam") ??
    ruleMatches.find((r) => r.result === "matched");
  const explicitRule = matched ? { action: matched.ruleGroup.action, ruleGroupId: matched.ruleGroup.id } : null;
  // A structurally-matching important rule whose stored DKIM/DMARC binding
  // failed to verify must not be silently ignored — that's exactly the
  // spoofed-sender case the binding exists to catch — so it forces Review
  // rather than letting the message fall through to ordinary handling.
  const authFailedImportantRule = explicitRule?.action !== "spam" && ruleMatches.some(
    (r) => r.result === "auth_failed" && r.ruleGroup.action === "important"
  );

  return {
    stub: resolvedStub,
    normalized,
    labelIds,
    nativeSpam,
    explicitRule,
    authFailedImportantRule,
    bypassed: explicitRule?.action === "spam" || nativeSpam
  };
}

/**
 * `threads.get` (the thread-reply-protection Gmail call) is only actually
 * needed to decide whether a message that WOULD otherwise be trashed
 * (native spam, an explicit spam rule, or a high-confidence AI verdict)
 * should instead be protected because the user has replied in its thread.
 * Content protection itself is derived from actionable/calendar assessment
 * signals after classification; labels alone do not block cleanup. This is
 * what lets the
 * thread-reply-protection fix from an earlier pass avoid roughly doubling
 * Gmail call volume on every run.
 */
async function finalizeOutcome(
  pre: PreprocessedMessage,
  assessmentResult: AssessmentResult | null,
  deps: OrchestratorDeps,
  threadSentCache: Map<string, Promise<boolean>>,
  diagnostics: ScanDiagnostics
): Promise<MessageOutcome> {
  const { stub, normalized, labelIds, nativeSpam, explicitRule, authFailedImportantRule } = pre;

  const assessment = assessmentResult?.ok ? assessmentResult.assessment : null;
  const assessmentUnavailable = !pre.bypassed && assessmentResult !== null && !assessmentResult.ok;

  const contentIsActionableOrCalendar = assessment !== null && (
    assessment.event.intent !== "none" ||
    assessment.reasonCodes.some((reason) =>
      ["security", "financial", "reservation", "deadline", "user_action_required", "direct_question"].includes(reason)
    )
  );
  // An explicit spam rule is a direct user instruction. The command path
  // marks it as an intentional override of the content safety guard,
  // including an actionable/calendar assessment.
  const protectedForPolicy = contentIsActionableOrCalendar;
  const policyInput: MessagePolicyInput = {
    gmailMessageId: stub.id,
    isInInbox: isInInbox(labelIds),
    isRead: isRead(labelIds),
    isNativeSpam: nativeSpam,
    isProtected: protectedForPolicy,
    explicitRule,
    explicitSpamOverride: explicitRule?.action === "spam",
    hasAuthenticatedHighRiskSignal: hasAuthenticatedHighRiskSignal(normalized),
    assessment,
    assessmentUnavailable
  };
  let rawDecision = evaluateMessagePolicy(policyInput, deps.policyThresholds);

  if (explicitRule?.action !== "spam" && !protectedForPolicy && rawDecision.actions.some((a) => a.type === "trash")) {
    let threadHasUserSentMessagePromise: Promise<boolean>;
    if (deps.sentThreadIndexUnavailable) {
      // An incomplete protection index is not evidence that the thread is
      // safe. Hold the destructive action for review instead of guessing.
      threadHasUserSentMessagePromise = Promise.reject(new Error("sent_thread_index_unavailable"));
    } else if (deps.sentThreadIds !== undefined) {
      // `messages.list` already supplied every SENT message's threadId for
      // this run. This is a local set lookup: no per-candidate `threads.get`
      // call, no 40-unit quota charge, and no extra network round trip.
      threadHasUserSentMessagePromise = Promise.resolve(deps.sentThreadIds.has(stub.threadId));
    } else if (deps.loadSentThreadIds) {
      threadHasUserSentMessagePromise = deps.loadSentThreadIds().then((ids) => ids.has(stub.threadId));
    } else {
      // Retain the direct lookup as a safe fallback for library callers that
      // do not provide the run-level Sent index.
      let cached = threadSentCache.get(stub.threadId);
      if (!cached) {
        diagnostics.threadChecks += 1;
        cached = fetchThreadHasUserSentMessage(deps.gmailClient, stub.threadId);
        threadSentCache.set(stub.threadId, cached);
      }
      threadHasUserSentMessagePromise = cached;
    }
    // A single message's thread-reply check must never crash the whole
    // run (CLAUDE.md: "Continue independent actions after an isolated
    // failure") — a sustained per-minute quota error here previously
    // propagated straight out of mapWithConcurrency and killed the entire
    // `gmail work` invocation, discarding every other message's already-
    // completed work in the same process. On failure (exhausted retries,
    // network outage, etc.) this can't know whether the user actually
    // replied in the thread, so it takes the same conservative branch as
    // a real "yes" — never trash on an inconclusive answer — and routes
    // the message to Review instead of silently guessing either way.
    let threadCheckFailed = false;
    let threadHasUserSentMessage: boolean;
    try {
      threadHasUserSentMessage = await threadHasUserSentMessagePromise;
    } catch {
      diagnostics.threadCheckFailures += 1;
      threadCheckFailed = true;
      threadHasUserSentMessage = true;
    }
    if (threadHasUserSentMessage) {
      // The user has replied in this thread — never trash it, regardless
      // of what triggered the trash decision above (native spam, an
      // explicit spam rule, or a high-confidence AI verdict all reuse this
      // one re-evaluation instead of three separate checks).
      rawDecision = evaluateMessagePolicy({ ...policyInput, isProtected: true }, deps.policyThresholds);
      if (threadCheckFailed) {
        rawDecision = { ...rawDecision, needsReview: true, reviewReason: "thread_reply_check_failed" };
      }
    }
  }

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
    // A hallucinated or injected date must never produce a real Calendar
    // event just because the model asserted one (CLAUDE.md: "validate that
    // short sourceEvidence is actually present in the normalized message
    // when it is used to justify a date"). Checked before the date/time
    // shape validation below, using the same downgrade-to-review path.
    const evidenceOk = sourceEvidencePresent(calendarAction.event.sourceEvidence, normalized.bodyText ?? normalized.snippet);
    const validation = evidenceOk
      ? validateEventCandidate(calendarAction.event, deps.clock.now(), deps.userTimezone)
      : ({ ok: false, reason: "missing_source_evidence" } as const);
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

  // Reduce the long tail of low-value mail without weakening the existing
  // protection rules. This only applies after a full usable assessment, a
  // 90-day retention window, and no critical signal/event. It deliberately
  // catches both read and unread messages that would otherwise remain
  // unchanged forever.
  const ageMs = Number(normalized.internalDate) > 0
    ? Math.max(0, deps.clock.now().getTime() - Number(normalized.internalDate))
    : 0;
  const ageDays = ageMs / 86_400_000;
  const oldLowValue =
    decision.actions.length === 0 &&
    !decision.needsReview &&
    !protectedForPolicy &&
    !nativeSpam &&
    explicitRule === null &&
    ageDays >= OLD_LOW_VALUE_DAYS &&
    assessment !== null &&
    (assessment.kind === "personal_routine" || assessment.kind === "automated_low_value") &&
    assessment.confidence >= 0.8 &&
    !hasAuthenticatedHighRiskSignal(normalized) &&
    assessment.event.intent === "none" &&
    !assessment.reasonCodes.some((reason) =>
      ["security", "financial", "reservation", "receipt", "deadline", "user_action_required", "direct_question"].includes(reason)
    );
  if (oldLowValue) {
    decision = { actions: [{ type: "trash", reasonCode: "old_low_value" }], needsReview: false, reviewReason: null };
  }

  let automaticSpamRuleCandidate: AutomaticSpamRuleCandidate | null = null;
  const bulkIdentity = normalized.listId
    ? { kind: "list_id" as const, normalizedValue: normalizeListId(normalized.listId) }
    : normalized.from.address
      ? { kind: "from_address" as const, normalizedValue: normalizeAddress(normalized.from.address) }
      : null;
  const isRepeatedBulkCandidate =
    assessment !== null &&
    !protectedForPolicy &&
    !nativeSpam &&
    !normalized.isFromUser &&
    explicitRule === null &&
    !isRead(labelIds) &&
    !decision.needsReview &&
    decision.actions.some((action) => action.type === "trash") &&
    (assessment.kind === "promotion" || assessment.kind === "automated_low_value") &&
    assessment.confidence >= 0.9 &&
    !hasAuthenticatedHighRiskSignal(normalized) &&
    hasBulkHeaderSignal(normalized) &&
    bulkIdentity !== null;
  if (isRepeatedBulkCandidate && bulkIdentity !== null) {
    automaticSpamRuleCandidate = {
      categoryName: `Auto spam: ${bulkIdentity.normalizedValue}`,
      matcher: { kind: bulkIdentity.kind, normalizedValue: bulkIdentity.normalizedValue, authBinding: null }
    };
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
    isUnread: !isRead(labelIds),
    automaticSpamRuleCandidate
  };
}
