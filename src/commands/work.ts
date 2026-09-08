import { formatBatchDiagnostics, hydrateMessagesBatched } from "../gmail/batch-hydrate.js";
import { batchHydrationEnabled, configuredBatchSize } from "../gmail/hydration-options.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import type { gmail_v1 } from "googleapis";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { runWorkScan } from "../core/orchestrator.js";
import { resolveClassifier } from "../ai/resolve-classifier.js";
import { RuleGroupsRepository } from "../state/repositories/rule-groups.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { RunsRepository, ActionsRepository } from "../state/repositories/runs.js";
import { CalendarLinksRepository } from "../state/repositories/calendar-links.js";
import { buildPlannedActions } from "../core/action-plan.js";
import { POLICY_VERSION } from "../core/policy.js";
import { renderExecutiveSummary, renderHumanSummary, renderImportantEmailsParagraph } from "../summary/render-human.js";
import { renderJsonSummary } from "../summary/render-json.js";
import { EXIT_CODES } from "../core/errors.js";
import { newRunId } from "../core/ids.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import {
  applyGroupedLabelMutations,
  archiveMutation,
  combineMutations,
  labelOnlyMutation,
  markImportantOnlyMutation,
  starOnlyMutation,
  trashMutation
} from "../gmail/executor.js";
import { getOrCreateLabelId, listUserLabels } from "../gmail/custom-labels.js";
import { LabelCandidatesRepository } from "../state/repositories/label-candidates.js";
import { MessagesRepository, type CachedMessageRecord } from "../state/repositories/messages.js";
import { buildEventInsertPlan, insertIdempotentEvent } from "../calendar/idempotency.js";
import { googleApiRateLimiter } from "../core/api-retry.js";
import { fetchMessageMinimal, listSentThreadIds } from "../gmail/scanner.js";
import { contentHash } from "../core/ids.js";
import type { CachedAssessmentSnapshot } from "../core/orchestrator.js";
import type { PolicyActionIntent } from "../core/policy.js";
import type { ActionType, PlannedAction, ReasonCode } from "../core/models.js";
import { createClassifierProgress, createReadProgress } from "./progress.js";

export interface WorkOptions {
  dryRun: boolean;
  json: boolean;
  /** Caps the Inbox and native-Spam scans to this many most-recent messages each, to bound Gmail API quota usage. */
  limit?: number;
}

export interface CurrentCacheVersions {
  classifierVersion: string;
  promptVersion: string;
  schemaVersion: string;
  policyVersion: string;
}

/**
 * Selects the exact local Inbox/Spam backlog that needs a live hydration
 * pass. A current, event-free assessment (or a completed rules-only/
 * deterministic evaluation, represented by matching versions with a null
 * assessmentKind) is already done and stays out of the queue.
 */
export function selectCachedBacklogStubs(
  rows: readonly CachedMessageRecord[],
  versions: CurrentCacheVersions
): Array<{ id: string; threadId: string }> {
  return rows
    .filter((row) => row.labelSnapshot.includes("INBOX") || row.labelSnapshot.includes("SPAM"))
    .filter(
      (row) =>
        row.classifierVersion !== versions.classifierVersion ||
        row.promptVersion !== versions.promptVersion ||
        row.schemaVersion !== versions.schemaVersion ||
        row.policyVersion !== versions.policyVersion ||
        // Calendar source evidence and payload are deliberately absent
        // from SQLite, so such an assessment cannot safely be
        // reconstructed from its compact projection.
        (row.assessmentKind !== null && row.assessmentHadEvent !== false)
    )
    .map((row) => ({ id: row.gmailMessageId, threadId: row.gmailThreadId }));
}

/** `labelIdByName` must already hold an entry for every label action's name (lowercased) before this is called. */
function mutationForActions(actions: readonly PolicyActionIntent[], labelIdByName: ReadonlyMap<string, string>) {
  const mutations = actions
    .filter(
      (a): a is Extract<PolicyActionIntent, { type: "star" | "mark_important" | "archive" | "label" }> =>
        a.type === "star" || a.type === "mark_important" || a.type === "archive" || a.type === "label"
    )
    .map((a) => {
      if (a.type === "star") return starOnlyMutation();
      if (a.type === "mark_important") return markImportantOnlyMutation();
      if (a.type === "archive") return archiveMutation();
      const labelId = labelIdByName.get(a.labelName.trim().toLowerCase());
      // Should always be present — the caller resolves every needed label
      // before building mutations — but a message simply keeps whatever
      // its other actions already do rather than throwing if not.
      return labelId ? labelOnlyMutation(labelId) : { addLabelIds: [], removeLabelIds: [] };
    });
  return combineMutations(mutations);
}

export async function runWork(options: WorkOptions): Promise<number> {
  const ctx = bootstrap();
  const { account, gmailClient, calendarClient, oauthClient } = await resolveAccountSigningInIfNeeded(ctx);

  const { classifier, description, classifierVersion, promptVersion, schemaVersion } = await resolveClassifier({
    accountHash: account.accountHash,
    credentialStore: ctx.credentialStore,
    config: ctx.config
  });
  // Always goes to stderr, even in --json mode: it never touches stdout,
  // so it can't corrupt a piped JSON summary, and this is important
  // enough to not hide from a human who happens to be running --json.
  console.error(pc.dim(description));

  const lock = options.dryRun ? null : new ProcessLock(lockFilePath(account.accountHash));
  lock?.acquire();

  ctx.logger.info({ accountHash: account.accountHash, dryRun: options.dryRun }, "work_run_start");
  const readProgress = createReadProgress({ interactive: !options.json });
  const unsubscribeQuotaWait = googleApiRateLimiter.subscribeQuotaWait((waitMs) => readProgress.onQuotaWait(waitMs));

  try {
    readProgress.onPhase("preparing");
    const ruleGroups = new RuleGroupsRepository(ctx.db).listEnabled(account.accountHash);

    // Reading the label list is safe even in --dry-run (no mutation); it's
    // what lets the classifier prefer reusing an existing label over
    // inventing a near-duplicate. `labelIdByName` seeds label resolution
    // below for any label actions that survive the run's threshold check.
    const existingLabels = await listUserLabels(gmailClient);
    let sentIndexPromise: Promise<ReadonlySet<string>> | undefined;
    const loadSentThreadIds = (): Promise<ReadonlySet<string>> => {
      if (!sentIndexPromise) {
        readProgress.onPhase("reconciling");
        sentIndexPromise = listSentThreadIds(gmailClient, (count) => readProgress.onProgress(count))
          .finally(() => readProgress.onFinish());
      }
      return sentIndexPromise;
    };
    const labelIdByName = new Map(existingLabels.map((l) => [l.name.trim().toLowerCase(), l.id]));
    // The AI category prompt depends on the current custom-label set, and
    // deterministic decisions depend on the current enabled rule set.
    // Fold both into the cache-policy version so either local-context
    // change queues only the cached Inbox/Spam rows for targeted
    // re-evaluation instead of silently reusing a decision made under
    // different inputs.
    const cacheContextHash = contentHash(
      JSON.stringify({
        labels: existingLabels.map((label) => label.name.trim().toLowerCase()).sort(),
        rules: ruleGroups
          .map((rule) => ({
            id: rule.id,
            action: rule.action,
            updatedAt: rule.updatedAt,
            matchers: [...rule.matchers]
              .map((matcher) => ({
                kind: matcher.kind,
                value: matcher.normalizedValue,
                auth: matcher.authBinding
              }))
              .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      })
    );
    const cachePolicyVersion = `${POLICY_VERSION}:${cacheContextHash.slice(0, 16)}`;

    const labelCandidatesRepo = new LabelCandidatesRepository(ctx.db);
    const priorLabelCandidateCounts = new Map(
      labelCandidatesRepo
        .listForAccount(account.accountHash)
        .map((c) => [c.normalizedName, { displayName: c.displayName, count: c.pendingCount }] as const)
    );
    const priorLabelCandidateVotedMessageIds = labelCandidatesRepo.listVotedMessageIdsForAccount(account.accountHash);

    // Reused, still-valid assessments from `gmail cache` and prior `gmail
    // work` runs (the actual mechanism behind "use the cache instead of
    // re-reading everything" — see OrchestratorDeps.cachedAssessments):
    // only rows this same pipeline previously classified (assessmentKind
    // non-null) are eligible, since a `gmail cache`-only placeholder row
    // has no assessment to reuse.
    const messagesRepo = new MessagesRepository(ctx.db);
    const cachedRows = messagesRepo.listForAccount(account.accountHash);
    const cachedAssessments = new Map<string, CachedAssessmentSnapshot>(
      cachedRows
        // Event evidence/payload is intentionally not persisted. Reusing
        // such an incomplete row would silently turn a prior Calendar
        // candidate into `event: none`, so only explicitly event-free
        // assessments are safe cache hits.
        .filter((r) => r.assessmentKind !== null && r.assessmentHadEvent === false)
        .map(
          (r) =>
            [
              r.gmailMessageId,
              {
                contentHash: r.contentHash,
                classifierVersion: r.classifierVersion ?? "not-configured",
                promptVersion: r.promptVersion ?? "not-configured",
                schemaVersion: r.schemaVersion ?? "not-configured",
                policyVersion: r.policyVersion ?? "not-configured",
                kind: r.assessmentKind as CachedAssessmentSnapshot["kind"],
                confidence: r.assessmentConfidence ?? 0,
                importanceScore: r.importanceScore ?? 0,
                importanceConfidence: r.importanceConfidence ?? 0,
                reasonCodes: (r.reasonCodes ?? []) as readonly ReasonCode[],
                category: r.category
              } satisfies CachedAssessmentSnapshot
            ] as const
        )
    );
    // `gmail cache` advances the Gmail history fence after taking its full
    // snapshot, so those pre-existing messages will not appear in a later
    // history.list response unless they happen to change. Queue every
    // actionable cache row that has never been evaluated (or was evaluated
    // under an older model/prompt/schema/policy) for one targeted live pass.
    // This is the missing read side that makes the stored rows useful: the
    // cache supplies the exact backlog IDs, avoiding another full mailbox
    // listing, and each successfully evaluated row drops out of this queue
    // on subsequent runs.
    const cachedBacklogStubs = selectCachedBacklogStubs(cachedRows, {
      classifierVersion,
      promptVersion,
      schemaVersion,
      policyVersion: cachePolicyVersion
    });

    const {
      summary,
      outcomes,
      scanNote,
      newHistoryMarker,
      usedIncrementalSync,
      labelCandidateUpdates,
      messageCacheUpdates,
      diagnostics,
      cacheEvictionMessageIds
    } = await runWorkScan({
      gmailClient,
      oauthClient,
      classifier,
      ruleGroups,
      userEmail: account.emailDisplay ?? "",
      userTimezone: account.timezone,
      clock: ctx.clock,
      concurrency: { gmailReads: 5, aiCalls: ctx.config?.concurrency.aiCalls ?? 5 },
      existingLabels: existingLabels.map((l) => l.name),
      priorLabelCandidateCounts,
      priorLabelCandidateVotedMessageIds,
      classifierVersion,
      promptVersion,
      schemaVersion,
      cachePolicyVersion,
      cachedAssessments,
      cachedBacklogStubs,
      loadSentThreadIds,
      progress: createClassifierProgress({ interactive: !options.json }),
      readProgress,
      onBatchDiagnostics: (batchDiagnostics) => {
        readProgress.writeMessage(formatBatchDiagnostics(batchDiagnostics));
        ctx.logger.info({ ...batchDiagnostics }, "work_batch_reads_complete");
      },
      // Incremental sync against Gmail's history API is the main lever for
      // staying under Gmail's API quota on repeat runs — see
      // CLAUDE.md's "Incremental synchronization". Passing null/omitting
      // forces a full snapshot (this account's first-ever run).
      historyMarker: account.historyMarker,
      ...(options.limit !== undefined ? { limit: options.limit } : {})
    });
    readProgress.onFinish();
    // Always goes to stderr for the same reason as the classifier
    // description above: informational, never part of a piped --json summary.
    console.error(
      pc.dim(usedIncrementalSync ? "Incremental scan (via Gmail history)." : "Full inbox/spam snapshot scan.")
    );
    const gmailScanMs =
      diagnostics.profileMs +
      diagnostics.historyMs +
      diagnostics.listingMs +
      diagnostics.messageFetchMs +
      diagnostics.inboxCountMs;
    console.error(
      pc.dim(
        `Scan timing: Gmail ${Math.round(gmailScanMs)}ms; AI ${Math.round(diagnostics.classificationMs)}ms ` +
          `(${diagnostics.classifierCalls} call(s), ${diagnostics.assessmentCacheHits} cache hit(s)); ` +
          `policy/safety ${Math.round(diagnostics.policyMs)}ms (${diagnostics.threadChecks} thread check(s)); ` +
          `total ${Math.round(diagnostics.totalMs)}ms.`
      )
    );
    ctx.logger.info(
      { accountHash: account.accountHash, usedIncrementalSync, scannedCount: outcomes.length, scanNote, ...diagnostics },
      "work_scan_complete"
    );

    // Give the user a decision preview before any Gmail or Calendar mutation
    // begins. In JSON mode this stays on stderr so stdout remains valid JSON.
    console.error(pc.dim(renderExecutiveSummary(summary)));

    let runId: string | undefined;
    let failureCount = summary.failureCount;

    if (!options.dryRun) {
      runId = newRunId();
      const nowIso = ctx.clock.nowIso();
      const runsRepo = new RunsRepository(ctx.db);
      const actionsRepo = new ActionsRepository(ctx.db);

      // Reconcile any action left `applying` by a crashed prior run before
      // planning new ones. The remote result of an interrupted mutation
      // cannot be safely queried, so it is marked unknown and never retried
      // automatically.
      for (const stale of actionsRepo.findApplying(account.accountHash)) {
        actionsRepo.updateStatus(stale.actionKey, "unknown_no_retry", nowIso, "crash_reconciliation");
      }

      runsRepo.create({
        runId,
        accountHash: account.accountHash,
        mode: "work",
        policyVersion: POLICY_VERSION,
        classifierVersion,
        promptVersion,
        schemaVersion,
        startedAt: nowIso,
        finishedAt: null,
        status: "running",
        counters: {},
        errorSummary: null
      });

      const trashTargets: string[] = [];
      const nonTrashOutcomes: typeof outcomes = [];
      const actionsByMessageId = new Map<string, PlannedAction[]>();

      for (const outcome of outcomes) {
        const isTrash = outcome.decision.actions.some((a) => a.type === "trash");
        const planned = buildPlannedActions(outcome.decision.actions, {
          runId,
          accountHash: account.accountHash,
          gmailMessageId: outcome.gmailMessageId,
          gmailThreadId: outcome.gmailThreadId,
          beforeStateHash: contentHash(JSON.stringify([...outcome.labelIdsAtSnapshot].sort())),
          nowIso
        });
        if (planned.length > 0) {
          actionsRepo.upsertPlanned(planned);
          actionsByMessageId.set(outcome.gmailMessageId, planned);
        }
        if (isTrash) {
          trashTargets.push(outcome.gmailMessageId);
        } else {
          nonTrashOutcomes.push(outcome);
        }
      }

      // Resolve every label name this run actually needs to a real Gmail
      // label ID, creating new ones only now that a real (non-dry-run) run
      // is committed to acting. A name that fails to resolve (e.g. a
      // transient Gmail error creating it) is simply left out of every
      // mutation that needed it below, rather than failing the whole run.
      const neededLabelNames = new Set<string>();
      for (const outcome of nonTrashOutcomes) {
        for (const action of outcome.decision.actions) {
          if (action.type === "label") neededLabelNames.add(action.labelName);
        }
      }
      for (const name of neededLabelNames) {
        if (!labelIdByName.has(name.trim().toLowerCase())) {
          try {
            await getOrCreateLabelId(gmailClient, name, labelIdByName);
          } catch {
            // Left unresolved; mutationForActions below omits it for this run.
          }
        }
      }

      const labelTargets: { messageId: string; mutation: ReturnType<typeof mutationForActions> }[] = [];
      for (const outcome of nonTrashOutcomes) {
        const mutation = mutationForActions(outcome.decision.actions, labelIdByName);
        if (mutation.addLabelIds.length > 0 || mutation.removeLabelIds.length > 0) {
          labelTargets.push({ messageId: outcome.gmailMessageId, mutation });
        }
      }

      // Moves this message's action-ledger rows of the given type(s) to a
      // new status. A row already reconciled to a terminal status by
      // upsertPlanned's own guard is simply re-set here, which is fine
      // since this function is the one actually executing right now.
      const markActions = (
        messageId: string,
        types: readonly ActionType[],
        status: PlannedAction["status"],
        errorClass: string | null = null
      ): void => {
        for (const row of actionsByMessageId.get(messageId) ?? []) {
          if (types.includes(row.type)) {
            actionsRepo.updateStatus(row.actionKey, status, ctx.clock.nowIso(), errorClass);
          }
        }
      };

      // Immediately before mutating, re-fetch current label state so a
      // change the user made after the snapshot (e.g. starring a message)
      // is respected rather than overwritten.
      const survivingTrash: string[] = [];
      let checkedTrash = 0;
      let failedTrashChecks = 0;
      if (trashTargets.length > 0) readProgress.onPhase("reconciling", trashTargets.length);
      const recordTrashCheck = (messageId: string, data: gmail_v1.Schema$Message | null): void => {
        if (data === null) {
          markActions(messageId, ["trash"], "failed_retryable", "precondition_check_failed");
          failureCount += 1;
          failedTrashChecks += 1;
        } else {
          const labels = data.labelIds ?? [];
          if (labels.includes("STARRED") || labels.includes("IMPORTANT") ||
            (!labels.includes("INBOX") && !labels.includes("SPAM"))) {
            markActions(messageId, ["trash"], "skipped_conflict");
          } else {
            survivingTrash.push(messageId);
          }
        }
        readProgress.onProgress(++checkedTrash, trashTargets.length, failedTrashChecks);
      };
      if (batchHydrationEnabled()) {
        await hydrateMessagesBatched(gmailClient, oauthClient, trashTargets, recordTrashCheck,
          { initialBatchSize: configuredBatchSize(), format: "minimal" });
      } else {
        await mapWithConcurrency(trashTargets, 5, async (messageId) => {
          let data: gmail_v1.Schema$Message | null;
          try { data = await fetchMessageMinimal(gmailClient, messageId); }
          catch { data = null; }
          recordTrashCheck(messageId, data);
        });
      }
      readProgress.onFinish(failedTrashChecks === 0);

      const successfullyTrashed = new Set<string>();
      for (const messageId of survivingTrash) markActions(messageId, ["trash"], "applying");
      const trashResult = await applyGroupedLabelMutations(gmailClient,
        survivingTrash.map((messageId) => ({ messageId, mutation: trashMutation() })));
      for (const messageId of trashResult.succeededMessageIds) {
        markActions(messageId, ["trash"], "applied");
        successfullyTrashed.add(messageId);
      }
      for (const messageId of trashResult.failedMessageIds) {
        markActions(messageId, ["trash"], "failed_retryable", "gmail_api_error");
        failureCount += 1;
      }

      for (const { messageId } of labelTargets) {
        markActions(messageId, ["star", "mark_important", "archive", "label"], "applying");
      }
      const labelResult = await applyGroupedLabelMutations(gmailClient, labelTargets);
      for (const messageId of labelResult.succeededMessageIds) {
        markActions(messageId, ["star", "mark_important", "archive", "label"], "applied");
      }
      for (const messageId of labelResult.failedMessageIds) {
        markActions(messageId, ["star", "mark_important", "archive", "label"], "failed_retryable", "gmail_api_error");
        failureCount += 1;
      }
      const outcomeByMessageId = new Map(outcomes.map((outcome) => [outcome.gmailMessageId, outcome] as const));
      const successfullyArchived = new Set(
        labelResult.succeededMessageIds.filter((messageId) =>
          outcomeByMessageId.get(messageId)?.decision.actions.some((action) => action.type === "archive")
        )
      );

      // Calendar creation: only for outcomes whose event candidate already
      // passed real-code date/shape validation (see orchestrator.ts). The
      // deterministic event ID makes this safe to run every time — a
      // repeat for the same message/candidate never creates a duplicate.
      const calendarLinksRepo = new CalendarLinksRepository(ctx.db);
      let calendarCreated = 0;
      for (const outcome of outcomes) {
        if (!outcome.validatedEvent || survivingTrash.includes(outcome.gmailMessageId)) {
          continue;
        }
        markActions(outcome.gmailMessageId, ["calendar_create"], "applying");
        const plan = buildEventInsertPlan({
          accountHash: account.accountHash,
          gmailMessageId: outcome.gmailMessageId,
          gmailThreadId: outcome.gmailThreadId,
          classifierVersion: outcome.classifierVersion ?? "unknown",
          candidateIndex: 0,
          event: outcome.validatedEvent
        });
        try {
          const insertResult = await insertIdempotentEvent(calendarClient, plan);
          if (insertResult.kind === "inserted" || insertResult.kind === "already_applied_by_this_app") {
            calendarLinksRepo.upsert({
              accountHash: account.accountHash,
              gmailMessageId: outcome.gmailMessageId,
              candidateIndex: 0,
              calendarEventId: plan.eventId,
              payloadHash: plan.provenance.payloadHash,
              etag: insertResult.event.etag ?? null,
              status: "applied",
              createdAt: ctx.clock.nowIso()
            });
            markActions(outcome.gmailMessageId, ["calendar_create"], "applied");
            calendarCreated += 1;
          } else if (insertResult.kind === "collision") {
            calendarLinksRepo.upsert({
              accountHash: account.accountHash,
              gmailMessageId: outcome.gmailMessageId,
              candidateIndex: 0,
              calendarEventId: plan.eventId,
              payloadHash: plan.provenance.payloadHash,
              etag: null,
              status: "failed",
              createdAt: ctx.clock.nowIso()
            });
            // A different app-owned event already holds this deterministic
            // ID with different provenance: needs human review, not a retry.
            markActions(outcome.gmailMessageId, ["calendar_create"], "failed_terminal", "calendar_id_collision");
            failureCount += 1;
          } else {
            // ambiguous_retry: the remote result genuinely cannot be known
            // from this response. Never guess; the same deterministic ID is
            // safe to retry on a later run.
            markActions(outcome.gmailMessageId, ["calendar_create"], "unknown_no_retry", "ambiguous_insert_result");
          }
        } catch {
          markActions(outcome.gmailMessageId, ["calendar_create"], "failed_retryable", "calendar_api_error");
          failureCount += 1;
        }
      }

      const finishedAt = ctx.clock.nowIso();
      const runCounters = {
        trashed: survivingTrash.length,
        labelMutations: labelResult.succeededMessageIds.length,
        calendarCreated,
        failures: failureCount
      };
      const finalRunStatus = failureCount > 0 ? "partial_failure" : "completed";
      const completedRunId = runId;
      if (!completedRunId) {
        throw new Error("Work run ID was not initialized before checkpoint persistence.");
      }

      // The history fence, message assessments, label-vote state, and run
      // completion are one local ingestion checkpoint. If the process
      // dies anywhere in this block SQLite rolls it all back, leaving the
      // old history marker in place so the next invocation safely
      // reconciles these messages again instead of skipping cache rows it
      // never durably wrote.
      const persistCheckpoint = ctx.db.transaction(() => {
        runsRepo.finish(
          completedRunId,
          finalRunStatus,
          finishedAt,
          runCounters,
          failureCount > 0
            ? `${failureCount} action(s) failed; see the actions table for run ${completedRunId}`
            : null
        );

        // Persist each category's updated cumulative count: cleared once
        // it crossed the threshold AND its Gmail label was actually
        // resolved; otherwise retain both the count and distinct votes.
        for (const update of labelCandidateUpdates) {
          const labelActuallyResolved = update.applied && labelIdByName.has(update.normalizedName);
          if (labelActuallyResolved) {
            labelCandidatesRepo.clear(account.accountHash, update.normalizedName);
            continue;
          }
          labelCandidatesRepo.upsert({
            accountHash: account.accountHash,
            normalizedName: update.normalizedName,
            displayName: update.displayName,
            pendingCount: update.newCumulativeCount,
            updatedAt: finishedAt
          });
          if (update.newlyVotedMessageIds.length > 0) {
            labelCandidatesRepo.recordVotes(account.accountHash, update.normalizedName, update.newlyVotedMessageIds);
          }
        }

        // Persist every scanned message's up-to-date cache row so a later
        // run can reuse the assessment or know the deterministic/rules-only
        // evaluation already completed under these exact versions.
        for (const update of messageCacheUpdates) {
          messagesRepo.upsert({
            accountHash: account.accountHash,
            gmailMessageId: update.gmailMessageId,
            gmailThreadId: update.gmailThreadId,
            contentHash: update.contentHash,
            labelSnapshot: update.labelSnapshot,
            classifierVersion: update.evaluatedVersions?.classifierVersion ?? null,
            promptVersion: update.evaluatedVersions?.promptVersion ?? null,
            schemaVersion: update.evaluatedVersions?.schemaVersion ?? null,
            policyVersion: update.evaluatedVersions?.policyVersion ?? null,
            assessmentKind: update.assessment?.kind ?? null,
            assessmentConfidence: update.assessment?.confidence ?? null,
            importanceScore: update.assessment?.importanceScore ?? null,
            importanceConfidence: update.assessment?.importanceConfidence ?? null,
            reasonCodes: update.assessment?.reasonCodes ?? null,
            processedAt: finishedAt,
            subject: update.subject,
            senderDisplay: update.senderDisplay,
            internalDate: update.internalDate,
            category: update.assessment?.category ?? null,
            assessmentHadEvent: update.assessmentHadEvent
          });
        }

        // Keep the cache's working set aligned with its Inbox+Spam scope.
        // This also prevents a cache-only backlog row that was archived,
        // trashed, or deleted from being hydrated again forever merely
        // because its old local label snapshot still said INBOX/SPAM.
        for (const messageId of new Set([
          ...cacheEvictionMessageIds,
          ...successfullyTrashed,
          ...successfullyArchived
        ])) {
          messagesRepo.delete(account.accountHash, messageId);
        }

        // Advance only after every other part of the checkpoint above is
        // ready to commit atomically.
        new AccountsRepository(ctx.db).updateHistoryMarker(account.accountHash, newHistoryMarker, finishedAt);
      });
      persistCheckpoint();

      ctx.logger.info(
        { runId: completedRunId, accountHash: account.accountHash, status: finalRunStatus, ...runCounters },
        "work_run_finished"
      );
    }

    const finalSummary = { ...summary, failureCount, scanNote };

    if (options.json) {
      console.error(renderImportantEmailsParagraph(finalSummary));
      console.log(
        JSON.stringify({ ...renderJsonSummary(finalSummary, { dryRun: options.dryRun }), runId: runId ?? null })
      );
    } else {
      console.log(renderHumanSummary(finalSummary, { dryRun: options.dryRun, ...(runId ? { runId } : {}) }));
    }
    return failureCount > 0 ? EXIT_CODES.operationalFailure : EXIT_CODES.ok;
  } finally {
    readProgress.onFinish(false);
    unsubscribeQuotaWait();
    lock?.release();
  }
}
