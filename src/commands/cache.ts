import { startRunDiagnostics } from "../logging/run-diagnostics.js";
import pc from "picocolors";
import type { gmail_v1 } from "googleapis";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { EXIT_CODES } from "../core/errors.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { MessagesRepository, type CachedMessageRecord } from "../state/repositories/messages.js";
import { dedupeStubs, resolvePostScanHistoryMarker } from "../core/orchestrator.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import {
  fetchProfile,
  fetchMessageFull,
  listAllMessageIds,
  type MessageStub
} from "../gmail/scanner.js";
import { projectHydratedCacheMessage } from "../gmail/cache-projection.js";
import { GMAIL_LABELS } from "../gmail/labels.js";
import { googleApiRateLimiter } from "../core/api-retry.js";
import { createReadProgress, type ReadProgressDisplay } from "./progress.js";
import { SETTING_KEYS, SettingsRepository } from "../state/repositories/settings.js";

// Full-message hydration is still paced by the shared, quota-weighted Gmail
// limiter. Keeping a few more reads in flight overlaps network latency without
// allowing the command to burst past the provider's per-user quota.
const GMAIL_CACHE_READ_CONCURRENCY = 8;

interface CacheProgress {
  start(): void;
  discovering(): void;
  hydrationStart(total: number): void;
  hydrationProgress(completed: number, cached: number, failed: number): void;
  finalizing(): void;
  finish(success: boolean): void;
  read: ReadProgressDisplay;
}

/**
 * Renders the cache's complete lifecycle, not just message hydration. The
 * discovery phase has no reliable total until both Gmail list calls finish,
 * so it is shown as the first (zero-percent) phase; hydration then advances
 * the bar through the expensive work, and marker reconciliation closes it.
 * stderr keeps stdout suitable for scripts and the final plaintext result.
 */
function createCacheProgress(): CacheProgress {
  let hydrationTotal = 0;
  const read = createReadProgress({ title: "Gmail cache" });

  return {
    read,
    start() {
      read.onPhase("preparing");
    },
    discovering() {
      read.onPhase("discovering");
    },
    hydrationStart(total) {
      hydrationTotal = total;
      read.onPhase("hydrating", total);
    },
    hydrationProgress(completed, _cached, failed) {
      read.onProgress(completed, hydrationTotal, failed);
    },
    finalizing() {
      read.onPhase("reconciling");
    },
    finish(success) {
      read.onFinish(success);
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
  const { account, gmailClient } = await resolveAccountSigningInIfNeeded(ctx);

  const lock = new ProcessLock(lockFilePath(account.accountHash));
  lock.acquire();
  const diagnosticsLog = startRunDiagnostics(ctx.logger, "cache", options.limit);
  const progress = createCacheProgress();
  const unsubscribeQuotaWait = googleApiRateLimiter.subscribeQuotaWait((waitMs) => progress.read.onQuotaWait(waitMs));
  progress.start();
  try {
    const profile = await fetchProfile(gmailClient);

    diagnosticsLog.phase("discovery");
    progress.discovering();
    let spamDiscovered = 0;
    let inboxDiscovered = 0;
    const [spamResult, inboxResult] = await Promise.all([
      listAllMessageIds(gmailClient, {
        labelIds: [GMAIL_LABELS.spam],
        includeSpamTrash: true,
        onProgress: (discovered) => {
          spamDiscovered = discovered;
          progress.read.onProgress(spamDiscovered + inboxDiscovered);
        },
        ...(options.limit !== undefined ? { safetyCapCount: options.limit } : {})
      }),
      listAllMessageIds(gmailClient, {
        labelIds: [GMAIL_LABELS.inbox],
        includeSpamTrash: false,
        onProgress: (discovered) => {
          inboxDiscovered = discovered;
          progress.read.onProgress(spamDiscovered + inboxDiscovered);
        },
        ...(options.limit !== undefined ? { safetyCapCount: options.limit } : {})
      })
    ]);
    const stubs = dedupeStubs([...spamResult.messages, ...inboxResult.messages]);

    if (spamResult.truncated || inboxResult.truncated) {
      // Never truncate silently, even under an explicit --limit: state
      // exactly how many are being skipped this run, matching the same
      // transparency `gmail work`'s scanNote already provides.
      progress.read.writeMessage(
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

    progress.read.writeMessage(pc.dim(
      `Caching ${stubs.length} message(s) with ${GMAIL_CACHE_READ_CONCURRENCY} concurrent, quota-paced reads...`
    ));

    const messagesRepo = new MessagesRepository(ctx.db);
    const existingRows = messagesRepo.listForAccount(account.accountHash);
    const existingById = new Map(existingRows.map((row) => [row.gmailMessageId, row]));
    const activeIds = new Set<string>();
    const completedIds = new Set<string>();
    let pendingRows: CachedMessageRecord[] = [];
    let pendingDeletes: string[] = [];
    let cached = 0;
    let failed = 0;
    let removed = 0;
    const flushCache = (): void => {
      try {
        messagesRepo.applyCacheBatch(account.accountHash, pendingRows, pendingDeletes);
        cached += pendingRows.length;
        removed += pendingDeletes.length;
      } catch {
        // A failed SQLite transaction stores none of this chunk. Include
        // every affected result in the failure count and keep the old rows.
        failed += pendingRows.length + pendingDeletes.length;
      }
      pendingRows = [];
      pendingDeletes = [];
    };
    const acceptResult = (stub: MessageStub, raw: gmail_v1.Schema$Message | null): void => {
      if (completedIds.has(stub.id)) return;
      completedIds.add(stub.id);
      if (raw === null) {
        failed += 1;
      } else {
        try {
          const projection = projectHydratedCacheMessage(
            account.accountHash, profile.emailAddress, ctx.clock.nowIso(), stub, raw,
            existingById.get(stub.id) ?? null
          );
          if (projection === null) {
            pendingDeletes.push(stub.id);
          } else {
            pendingRows.push(projection);
            activeIds.add(stub.id);
          }
        } catch {
          failed += 1;
        }
      }
      // Keep network operations outside SQLite transactions while reducing
      // durable WAL commits from one per message to one per fifty results.
      if (pendingRows.length + pendingDeletes.length >= 50) flushCache();
      progress.hydrationProgress(completedIds.size, cached, failed);
    };
    diagnosticsLog.phase("hydration");
    progress.hydrationStart(stubs.length);
    try {
      await mapWithConcurrency(stubs, GMAIL_CACHE_READ_CONCURRENCY, async (stub) => {
        let raw: gmail_v1.Schema$Message | null;
        try { raw = await fetchMessageFull(gmailClient, stub.id); }
        catch { raw = null; }
        acceptResult(stub, raw);
      });
    } finally {
      flushCache();
      progress.hydrationProgress(completedIds.size, cached, failed);
    }

    // Reuse the pre-scan fence; the next incremental run reconciles changes
    // during hydration without another history request here.
    const snapshotComplete = failed === 0 && completedIds.size === stubs.length && !spamResult.truncated && !inboxResult.truncated;
    diagnosticsLog.phase("checkpoint");
    progress.finalizing();
    const newHistoryMarker = snapshotComplete
      ? await resolvePostScanHistoryMarker(gmailClient, profile.historyId)
      : null;
    ctx.db.transaction(() => {
      if (snapshotComplete) {
        // A complete full snapshot is authoritative about older cached
        // rows omitted from both current Inbox and Spam listings.
        const staleIds = existingRows.filter((row) => !activeIds.has(row.gmailMessageId)).map((row) => row.gmailMessageId);
        messagesRepo.applyCacheBatch(account.accountHash, [], staleIds);
      }
      // Advance only on a complete snapshot; an incomplete one keeps whatever
      // baseline already existed rather than destroying it (see
      // AccountsRepository.advanceHistoryMarker).
      new AccountsRepository(ctx.db).advanceHistoryMarker(account.accountHash, newHistoryMarker, ctx.clock.nowIso());
      const completedAt = ctx.clock.nowIso();
      new SettingsRepository(ctx.db).set(account.accountHash, SETTING_KEYS.cacheLastRunAt, completedAt, completedAt);
    })();

    progress.finish(failed === 0);

    console.log(
      `Cached ${cached} message(s)${removed > 0 ? ` (${removed} no longer in Inbox/Spam)` : ""}${failed > 0 ? ` (${failed} failed and were skipped)` : ""}. ` +
        (snapshotComplete
          ? "Future `gmail`/`gmail work` runs will hydrate this cached backlog once, then scan incrementally from here."
          : "The snapshot was incomplete, so it did not establish a new history baseline; any existing one is kept and a later full run recovers the omitted messages.")
    );
    return failed > 0 ? EXIT_CODES.operationalFailure : EXIT_CODES.ok;
  } finally {
    // If discovery, hydration, or marker reconciliation throws before the
    // normal success path, leave the user with an explicit terminal state
    // instead of a progress bar that appears to hang forever.
    progress.finish(false);
    unsubscribeQuotaWait();
    diagnosticsLog.finish();
    lock.release();
  }
}
