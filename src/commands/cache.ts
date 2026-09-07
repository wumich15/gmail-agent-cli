import pc from "picocolors";
import type { gmail_v1 } from "googleapis";
import { bootstrap, type CliContext } from "../core/bootstrap.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { EXIT_CODES } from "../core/errors.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { MessagesRepository } from "../state/repositories/messages.js";
import { dedupeStubs, resolvePostScanHistoryMarker } from "../core/orchestrator.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import {
  fetchProfile,
  fetchMessageFull,
  headersFromMessage,
  listAllMessageIds,
  type MailboxProfile,
  type MessageStub
} from "../gmail/scanner.js";
import { hydrateMessagesBatched } from "../gmail/batch-hydrate.js";
import { buildNormalizedMessage, extractBodyParts } from "../gmail/normalize.js";
import { GMAIL_LABELS } from "../gmail/labels.js";
import type { AccountRecord } from "../core/models.js";

// Full-message hydration is still paced by the shared, quota-weighted Gmail
// limiter. Keeping a few more reads in flight overlaps network latency without
// allowing the command to burst past the provider's per-user quota.
const GMAIL_CACHE_READ_CONCURRENCY = 8;

/**
 * Opt-in only: CLAUDE.md's "Planned Gmail read-transport optimization"
 * requires a live-account benchmark (200/500-message runs showing a
 * material wall-clock/request-count improvement with no higher 429 rate)
 * before multipart batching can default on, which this development
 * environment cannot run. Setting this makes `gmail cache` hydrate via
 * `gmail/batch-hydrate.ts` instead of one `messages.get` per message;
 * individual reads remain the always-available fallback within a batch run
 * itself (a failed/malformed outer batch falls back per-chunk) and the
 * unconditional default for everyone who hasn't opted in.
 */
function batchHydrationEnabled(): boolean {
  const raw = (process.env["GMAIL_AGENT_BATCH_HYDRATION"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Normalizes one fetched message and upserts its non-verbatim projection,
 * preserving a still-valid prior assessment exactly as before — shared by
 * both the individual-read and batched hydration paths so this logic (and
 * its "don't destroy `gmail work`'s assessment cache" fix) exists once.
 */
function upsertHydratedMessage(
  ctx: CliContext,
  account: AccountRecord,
  messagesRepo: MessagesRepository,
  profile: MailboxProfile,
  stub: MessageStub,
  raw: gmail_v1.Schema$Message
): void {
  const headers = headersFromMessage(raw);
  const labelIds = raw.labelIds ?? [];
  const { plain, html } = extractBodyParts(raw.payload ?? undefined);
  const normalized = buildNormalizedMessage({
    gmailMessageId: stub.id,
    gmailThreadId: stub.threadId,
    historyId: raw.historyId ?? "0",
    internalDate: raw.internalDate ?? "0",
    labelIds,
    snippet: raw.snippet ?? "",
    headers,
    htmlBody: html,
    plainBody: plain,
    userEmail: profile.emailAddress,
    threadHasUserSentMessage: false
  });
  // A prior `gmail work` run may have already classified this exact message
  // and cached its assessment (see core/orchestrator.ts's assessment-reuse
  // cache). `gmail cache` never classifies anything itself, but blindly
  // nulling those fields out here every time it re-runs would silently
  // destroy that cache and force every message to be reclassified by AI
  // again on the next `gmail work` run — preserve the existing assessment
  // whenever the content hasn't actually changed; only a genuinely
  // new/changed message gets a blank (correctly stale) assessment.
  const existing = messagesRepo.get(account.accountHash, stub.id);
  const preserveAssessment = existing !== null && existing.contentHash === normalized.contentHash;
  messagesRepo.upsert({
    accountHash: account.accountHash,
    gmailMessageId: stub.id,
    gmailThreadId: stub.threadId,
    contentHash: normalized.contentHash,
    labelSnapshot: labelIds,
    classifierVersion: preserveAssessment ? existing.classifierVersion : null,
    promptVersion: preserveAssessment ? existing.promptVersion : null,
    schemaVersion: preserveAssessment ? existing.schemaVersion : null,
    policyVersion: preserveAssessment ? existing.policyVersion : null,
    assessmentKind: preserveAssessment ? existing.assessmentKind : null,
    assessmentConfidence: preserveAssessment ? existing.assessmentConfidence : null,
    importanceScore: preserveAssessment ? existing.importanceScore : null,
    importanceConfidence: preserveAssessment ? existing.importanceConfidence : null,
    reasonCodes: preserveAssessment ? existing.reasonCodes : null,
    processedAt: preserveAssessment ? existing.processedAt : ctx.clock.nowIso(),
    subject: normalized.subject || null,
    senderDisplay: normalized.from.displayName ?? normalized.from.address,
    internalDate: normalized.internalDate,
    category: preserveAssessment ? existing.category : null,
    assessmentHadEvent: preserveAssessment ? existing.assessmentHadEvent : null
  });
}

interface CacheProgress {
  start(): void;
  discovering(): void;
  hydrationStart(total: number): void;
  hydrationProgress(completed: number, cached: number, failed: number): void;
  finalizing(): void;
  finish(success: boolean): void;
}

/**
 * Renders the cache's complete lifecycle, not just message hydration. The
 * discovery phase has no reliable total until both Gmail list calls finish,
 * so it is shown as the first (zero-percent) phase; hydration then advances
 * the bar through the expensive work, and marker reconciliation closes it.
 * stderr keeps stdout suitable for scripts and the final plaintext result.
 */
function createCacheProgress(): CacheProgress {
  let lastReported = -1;
  let finished = false;
  let hydrationTotal = 0;
  const isTerminal = Boolean(process.stderr.isTTY);

  const draw = (percent: number, detail: string, reportKey: number): void => {
    const width = 24;
    const filled = Math.round((percent / 100) * width);
    const bar = `${"#".repeat(Math.min(width, filled))}${"-".repeat(Math.max(0, width - filled))}`;
    const line = `Gmail cache [${bar}] ${percent}% ${detail}`;
    if (isTerminal) {
      process.stderr.write(`\r${line}`);
    } else if (reportKey === 0 || percent >= 100 || reportKey - lastReported >= 10) {
      console.error(line);
    }
    lastReported = reportKey;
  };

  return {
    start() {
      draw(0, "Starting", 0);
    },
    discovering() {
      draw(0, "Discovering Inbox + Spam", 0);
    },
    hydrationStart(total) {
      hydrationTotal = total;
      draw(total === 0 ? 95 : 10, total === 0 ? "No messages to hydrate" : `Hydrating 0/${total}`, 0);
    },
    hydrationProgress(completed, cached, failed) {
      const percent = hydrationTotal === 0 ? 95 : 10 + Math.round((completed / hydrationTotal) * 85);
      const failureText = failed > 0 ? `, ${failed} failed` : "";
      draw(percent, `Hydrating ${completed}/${hydrationTotal} (${cached} cached${failureText})`, completed);
    },
    finalizing() {
      draw(96, "Finalizing history baseline", 96);
    },
    finish(success) {
      if (finished) return;
      finished = true;
      draw(100, success ? "Complete" : "Stopped with errors", 100);
      if (isTerminal) process.stderr.write("\n");
    }
  };
}

/**
 * `gmail cache` — an explicit, read-only full snapshot of the whole Inbox
 * and native Spam. It makes no AI calls and no Gmail/Calendar mutations;
 * it exists purely so a user under Gmail API quota pressure can pay the
 * expensive full-traversal cost once, deliberately, and have every
 * `gmail`/`gmail work` run after it scan incrementally via Gmail's history
 * API instead of re-listing and re-fetching everything every time (see
 * CLAUDE.md's "Incremental synchronization"). Each visited message's
 * non-verbatim projection (content hash, label snapshot — never body text)
 * is recorded in the local `messages` table for future reuse; no
 * assessment fields are set since no classifier ever runs here.
 */
export interface CacheOptions {
  /** Caps the Inbox and native-Spam scans to this many most-recent messages each. Omit to cache everything. */
  limit?: number;
}

export async function runCache(options: CacheOptions = {}): Promise<number> {
  const ctx = bootstrap();
  const { account, gmailClient, oauthClient } = await resolveAccountSigningInIfNeeded(ctx);

  const lock = new ProcessLock(lockFilePath(account.accountHash));
  lock.acquire();
  const progress = createCacheProgress();
  progress.start();
  try {
    const profile = await fetchProfile(gmailClient);

    progress.discovering();
    const [spamResult, inboxResult] = await Promise.all([
      listAllMessageIds(gmailClient, {
        labelIds: [GMAIL_LABELS.spam],
        includeSpamTrash: true,
        ...(options.limit !== undefined ? { safetyCapCount: options.limit } : {})
      }),
      listAllMessageIds(gmailClient, {
        labelIds: [GMAIL_LABELS.inbox],
        includeSpamTrash: false,
        ...(options.limit !== undefined ? { safetyCapCount: options.limit } : {})
      })
    ]);
    const stubs = dedupeStubs([...spamResult.messages, ...inboxResult.messages]);

    if (spamResult.truncated || inboxResult.truncated) {
      // Never truncate silently, even under an explicit --limit: state
      // exactly how many are being skipped this run, matching the same
      // transparency `gmail work`'s scanNote already provides.
      console.error(
        pc.yellow(
          "--limit applied: " +
            [
              inboxResult.truncated
                ? `Inbox capped to ${inboxResult.messages.length}${inboxResult.estimatedTotal !== null ? ` of ~${inboxResult.estimatedTotal}` : ""}.`
                : null,
              spamResult.truncated
                ? `Spam capped to ${spamResult.messages.length}${spamResult.estimatedTotal !== null ? ` of ~${spamResult.estimatedTotal}` : ""}.`
                : null
            ]
              .filter(Boolean)
              .join(" ")
        )
      );
    }

    const useBatchHydration = batchHydrationEnabled();
    console.error(
      pc.dim(
        useBatchHydration
          ? `Caching ${stubs.length} message(s) via multipart batch hydration (GMAIL_AGENT_BATCH_HYDRATION=1)...`
          : `Caching ${stubs.length} message(s) with ${GMAIL_CACHE_READ_CONCURRENCY} concurrent, quota-paced reads...`
      )
    );

    const messagesRepo = new MessagesRepository(ctx.db);
    let cached = 0;
    let failed = 0;
    let outerBatchRequests = 0;
    let individualFallback = 0;
    progress.hydrationStart(stubs.length);
    try {
      if (useBatchHydration) {
        const stubById = new Map(stubs.map((stub) => [stub.id, stub]));
        const batchDiagnostics = await hydrateMessagesBatched(
          gmailClient,
          oauthClient,
          stubs.map((stub) => stub.id),
          (id, message) => {
            const stub = stubById.get(id);
            if (stub === undefined) return; // defensive: cannot happen, every id came from stubById's own keys
            if (message === null) {
              failed += 1;
            } else {
              try {
                upsertHydratedMessage(ctx, account, messagesRepo, profile, stub, message);
                cached += 1;
              } catch {
                failed += 1;
              }
            }
            progress.hydrationProgress(cached + failed, cached, failed);
          }
        );
        outerBatchRequests = batchDiagnostics.outerBatchRequests;
        individualFallback = batchDiagnostics.individualFallback;
      } else {
        await mapWithConcurrency(stubs, GMAIL_CACHE_READ_CONCURRENCY, async (stub) => {
          try {
            const raw = await fetchMessageFull(gmailClient, stub.id);
            upsertHydratedMessage(ctx, account, messagesRepo, profile, stub, raw);
            cached += 1;
          } catch {
            failed += 1;
          } finally {
            progress.hydrationProgress(cached + failed, cached, failed);
          }
        });
      }
    } finally {
      // Keep a visible 95% state even if an individual worker fails; the
      // final marker reconciliation below is a distinct, quota-bearing step.
      progress.hydrationProgress(cached + failed, cached, failed);
    }
    if (useBatchHydration) {
      console.error(
        pc.dim(
          `Batch hydration: ${outerBatchRequests} outer batch request(s), ${individualFallback} message(s) fell back to an individual read.`
        )
      );
    }

    // Same fence-then-reconcile pattern as a full `gmail work` scan: catch
    // anything that changed during this traversal so the marker we persist
    // doesn't leave a gap for the very next incremental run to miss. This
    // tolerates the reconciliation call itself failing (e.g. a sustained
    // Gmail quota error from having just fetched thousands of messages) by
    // falling back to the pre-scan fence — losing that one optimization is
    // far better than the whole command crashing here and never recording
    // a marker at all, throwing away the entire point of paying for this
    // expensive full traversal in the first place.
    const snapshotComplete = failed === 0 && !spamResult.truncated && !inboxResult.truncated;
    progress.finalizing();
    if (snapshotComplete) {
      const newHistoryMarker = await resolvePostScanHistoryMarker(gmailClient, profile.historyId);
      new AccountsRepository(ctx.db).updateHistoryMarker(account.accountHash, newHistoryMarker, ctx.clock.nowIso());
    }

    progress.finish(failed === 0);

    console.log(
      `Cached ${cached} message(s)${failed > 0 ? ` (${failed} failed and were skipped)` : ""}. ` +
        (snapshotComplete
          ? "Future `gmail`/`gmail work` runs will hydrate this cached backlog once, then scan incrementally from here."
          : "The snapshot was incomplete, so its history baseline was not advanced; a later full run can safely recover the omitted messages.")
    );
    return failed > 0 ? EXIT_CODES.operationalFailure : EXIT_CODES.ok;
  } finally {
    // If discovery, hydration, or marker reconciliation throws before the
    // normal success path, leave the user with an explicit terminal state
    // instead of a progress bar that appears to hang forever.
    progress.finish(false);
    lock.release();
  }
}
