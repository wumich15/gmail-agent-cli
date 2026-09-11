import type { GmailAgentDatabase } from "../state/database.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { MessagesRepository, type CachedMessageRecord } from "../state/repositories/messages.js";
import { SETTING_KEYS, SettingsRepository } from "../state/repositories/settings.js";
import type { AccountRecord } from "../core/models.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { ProcessLock } from "../core/lock.js";
import { SafetyPreconditionError } from "../core/errors.js";
import { apiErrorStatus } from "../core/api-retry.js";
import { setTimeout as delay } from "node:timers/promises";
import type { GmailClient } from "./client.js";
import { projectHydratedCacheMessage } from "./cache-projection.js";
import {
  fetchMessageFull,
  fetchProfile,
  historyIdGreaterThan,
  listMessagePage,
  type MessageStub
} from "./scanner.js";
import {
  VIEW_FOLDERS,
  messageIsInViewFolder,
  isViewCacheMessage,
  viewFolderDefinition,
  type ViewFolderId
} from "./view-folders.js";

export const VIEW_INITIAL_PAGE_COUNT = 3;
const VIEW_CACHE_READ_CONCURRENCY = 8;

/**
 * How long the loader stands aside after a chunk it ran purely in the
 * background.
 *
 * Every chunk takes the cross-process account lock for its whole
 * list-plus-hydrate span, and the pump used to start the next chunk the
 * instant the previous one committed. The lock file therefore existed
 * essentially continuously for as long as a view session was open, and
 * since a four-folder walk over a real mailbox never finishes quickly,
 * any other `gmail` command run alongside the viewer failed with
 * "another gmail process is already running". Pausing here leaves a real
 * window for `ProcessLock`'s bounded wait to succeed, and for this
 * session's own foreground keystrokes to jump the queue.
 */
const VIEW_BACKGROUND_CHUNK_PAUSE_MS = 400;

/** How long to wait between attempts when another process owns the lock. */
const VIEW_LOCK_RETRY_MS = 500;

/**
 * How long one chunk may keep retrying a lock another process holds
 * before giving up on that chunk.
 *
 * This retry loop used to be unbounded, which is what turned "another
 * gmail process is busy" into "gmail view hangs forever with no output":
 * startup awaits the first foreground chunk, and a chunk stuck in a
 * silent 500 ms retry loop never completes, never fails, and never wakes
 * the waiter. Bounding it converts an indefinite hang into a visible,
 * retryable "could not load right now".
 */
const VIEW_LOCK_WAIT_BUDGET_MS = 20_000;

/**
 * How long an interactive view action waits for another process's lock.
 * Deliberately shorter than DEFAULT_LOCK_WAIT_MS: this wait is synchronous,
 * so it also pauses the session's own background loading, and a keystroke
 * that appears to do nothing for ten seconds is its own kind of bug.
 */
const VIEW_FOREGROUND_LOCK_WAIT_MS = 3_000;

export type ViewExclusiveRunner = <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

/**
 * Internal scheduling signal: another process currently owns the account
 * lock, so progressive work should yield its in-process queue slot and try
 * again later. Foreground commands continue to receive the original
 * SafetyPreconditionError immediately.
 */
export class ViewBackgroundLockBusyError extends Error {
  constructor() {
    super("Another gmail process currently owns the progressive-view lock.");
    this.name = "ViewBackgroundLockBusyError";
  }
}

/**
 * Serializes this view session's bounded Gmail/cache operations while still
 * taking the normal cross-process account lock for each one. The lock is not
 * held while the terminal waits for input, and a background hydration cannot
 * commit stale labels after a foreground Trash/restore action.
 */
export class ViewOperationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly lockPath: string) {}

  readonly runExclusive: ViewExclusiveRunner = <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> => {
    const result = this.tail.then(async () => {
      const lock = new ProcessLock(this.lockPath);
      signal?.throwIfAborted();
      try {
        // Background work (which always passes a signal) fails fast and
        // retries outside this queue, so it must never park the event loop
        // and stall its own in-flight reads. A foreground action has
        // nothing else to do but wait, and erroring out because another
        // gmail command happened to be mid-operation would be worse than
        // pausing briefly for it.
        lock.acquire({ waitMs: signal ? 0 : VIEW_FOREGROUND_LOCK_WAIT_MS });
      } catch (error) {
        // Do not sleep while occupying the session queue. The progressive
        // loader catches this private scheduling error, waits outside the
        // queue, and retries; a foreground action can therefore run (or fail
        // fast on the same external lock) in the meantime.
        if (signal && error instanceof SafetyPreconditionError) {
          throw new ViewBackgroundLockBusyError();
        }
        throw error;
      }
      try {
        return await operation();
      } finally {
        lock.release();
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  async whenIdle(): Promise<void> {
    await this.tail;
  }
}

interface FolderLoadState {
  started: boolean;
  complete: boolean;
  blocked: boolean;
  nextPageToken: string | null;
  listed: number;
  estimatedTotal: number | null;
  failed: number;
  readonly seenIds: Set<string>;
  readonly seenPageTokens: Set<string>;
}

interface FolderDemand {
  cachedTarget: number;
  /** Bounds how many remote IDs this foreground wait may inspect. */
  listedLimit: number;
}

export interface ViewFolderLoadStatus {
  folder: ViewFolderId;
  cached: number;
  listed: number;
  estimatedTotal: number | null;
  complete: boolean;
  failed: number;
}

export interface ProgressiveViewCacheOptions {
  db: GmailAgentDatabase;
  gmailClient: GmailClient;
  account: AccountRecord;
  nowIso: () => string;
  pageSize: number;
  runExclusive: ViewExclusiveRunner;
  onCacheChanged?: (folder: ViewFolderId) => void;
  /** Overrides VIEW_BACKGROUND_CHUNK_PAUSE_MS; 0 disables the stand-aside pause (tests). */
  backgroundPauseMs?: number;
}

/**
 * Incrementally fills the four folders used by gmail view. A caller may wait
 * only for the rows needed to draw a page while the same controller keeps
 * walking every remaining Gmail page in the background.
 */
export class ProgressiveViewCache {
  private readonly states = new Map<ViewFolderId, FolderLoadState>();
  private readonly demand = new Map<ViewFolderId, FolderDemand>();
  private readonly activeIds = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private readonly abortController = new AbortController();
  private readonly chunkSize: number;
  private snapshotStartedAt: string | null = null;
  private priorityFolder: ViewFolderId = "inbox";
  private roundRobinIndex = 0;
  private backgroundEnabled = false;
  private stopped = false;
  private finished = false;
  private completedSuccessfully = false;
  private running: Promise<void> | null = null;
  private profile: { emailAddress: string; historyId: string } | null = null;
  private fatalError: unknown = null;
  private lockContended = false;

  constructor(private readonly options: ProgressiveViewCacheOptions) {
    // Exactly one UI page of mail per Gmail round trip. A chunk is also
    // one account-lock acquisition, so a larger chunk means a longer
    // stretch during which neither another `gmail` command nor this
    // session's own keystrokes can get in. A multi-page foreground
    // request is satisfied by several small chunks instead of one big one.
    this.chunkSize = Math.max(1, Math.min(500, options.pageSize));
    for (const folder of VIEW_FOLDERS) {
      this.states.set(folder.id, {
        started: false,
        complete: false,
        blocked: false,
        nextPageToken: null,
        listed: 0,
        estimatedTotal: null,
        failed: 0,
        seenIds: new Set(),
        seenPageTokens: new Set()
      });
    }
  }

  /**
   * Waits only until this many folder rows are cached, or Gmail reaches
   * EOF/fails — or, with `timeoutMs`, until that budget runs out.
   *
   * The timeout matters because this is what the interactive view awaits
   * before it can draw anything: without one, a loader that cannot make
   * progress (most often because another `gmail` process owns the account
   * lock) leaves the terminal with no prompt, no error, and no way to tell
   * whether it is working or wedged.
   */
  async ensureFolder(
    folder: ViewFolderId,
    desiredCachedCount: number,
    options: { timeoutMs?: number } = {}
  ): Promise<ViewFolderLoadStatus> {
    const deadline = options.timeoutMs === undefined ? null : Date.now() + Math.max(0, options.timeoutMs);
    const desired = Math.max(0, Math.floor(desiredCachedCount));
    const state = this.state(folder);
    const previous = this.demand.get(folder);
    const cachedTarget = Math.max(previous?.cachedTarget ?? 0, desired);
    this.priorityFolder = folder;
    this.demand.set(folder, {
      cachedTarget,
      // Gmail lists a folder newest-first, so its newest `cachedTarget` IDs
      // are exactly the rows needed to draw it — inspecting that many is
      // both necessary and sufficient, however many of them happen to be
      // cached already. Sizing this budget off the chunk instead made a
      // nearly-full folder stop one row short: the chunk was spent
      // re-listing rows that were already cached, and the budget ran out
      // before reaching the one that was missing.
      listedLimit: Math.max(previous?.listedLimit ?? 0, cachedTarget, this.chunkSize)
    });
    this.kick();

    for (;;) {
      const currentStatus = this.status(folder);
      const currentDemand = this.demand.get(folder)!;
      if (
        currentStatus.cached >= desired ||
        state.listed >= currentDemand.listedLimit ||
        state.complete ||
        state.blocked ||
        this.stopped ||
        this.fatalError
      ) {
        return currentStatus;
      }
      if (deadline !== null && Date.now() >= deadline) return currentStatus;
      await this.awaitProgress(deadline === null ? null : deadline - Date.now());
    }
  }

  /**
   * Resolves on the next loader state change, or after `timeoutMs`. The
   * timer is removed as soon as the loader reports progress so a long
   * foreground wait cannot accumulate pending timers.
   */
  private awaitProgress(timeoutMs: number | null): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.waiters.delete(waiter);
        if (timer) clearTimeout(timer);
        resolve();
      };
      const waiter = finish;
      this.waiters.add(waiter);
      if (timeoutMs !== null) {
        timer = setTimeout(finish, Math.max(0, timeoutMs));
        timer.unref?.();
      }
    });
  }

  /** Begins filling every folder, but deliberately does not return its completion promise. */
  startBackground(): void {
    if (this.stopped) return;
    this.backgroundEnabled = true;
    this.kick();
  }

  /** Useful to callers/tests that explicitly want to observe full completion. */
  async whenComplete(): Promise<boolean> {
    this.startBackground();
    for (;;) {
      if (this.finished) return this.completedSuccessfully;
      const cannotComplete = Boolean(this.fatalError) || [...this.states.values()].some((state) => state.blocked);
      if (this.stopped || (cannotComplete && this.running === null)) return false;
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  /** Cancels in-flight reads and prevents any later background chunk. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.backgroundEnabled = false;
    this.abortController.abort();
    this.notify();
    await this.running;
  }

  status(folder: ViewFolderId): ViewFolderLoadStatus {
    const state = this.state(folder);
    return {
      folder,
      cached: this.cachedCount(folder),
      listed: state.listed,
      estimatedTotal: state.estimatedTotal,
      complete: state.complete,
      failed: state.failed
    };
  }

  get error(): unknown {
    return this.fatalError;
  }

  /**
   * True when the last chunk could not start because another `gmail`
   * process owns the account lock. The view surfaces this so a stalled
   * folder reads as "another gmail command is running" rather than as an
   * unexplained empty list.
   */
  get waitingForAccountLock(): boolean {
    return this.lockContended;
  }

  /**
   * Protects a row that a foreground view action just verified or changed.
   * That action can occur after both relevant folder cursors passed the ID;
   * treating it as unseen during final pruning would erase a fresh local
   * projection even though Gmail just accepted the mutation.
   */
  retainId(messageId: string): void {
    this.activeIds.add(messageId);
  }

  private state(folder: ViewFolderId): FolderLoadState {
    const state = this.states.get(folder);
    if (!state) throw new Error(`Missing progressive-cache state for ${folder}.`);
    return state;
  }

  private cachedCount(folder: ViewFolderId): number {
    return new MessagesRepository(this.options.db)
      .listForAccount(this.options.account.accountHash)
      .filter((row) => messageIsInViewFolder(row.labelSnapshot, folder)).length;
  }

  private needsDemand(folder: ViewFolderId): boolean {
    const state = this.state(folder);
    const demand = this.demand.get(folder);
    return Boolean(
      demand &&
      !state.complete &&
      !state.blocked &&
      state.listed < demand.listedLimit &&
      this.cachedCount(folder) < demand.cachedTarget
    );
  }

  private nextFolder(): ViewFolderId | null {
    if (this.needsDemand(this.priorityFolder)) return this.priorityFolder;
    for (const folder of VIEW_FOLDERS) {
      if (this.needsDemand(folder.id)) return folder.id;
    }
    if (!this.backgroundEnabled) return null;
    for (let offset = 0; offset < VIEW_FOLDERS.length; offset += 1) {
      const index = (this.roundRobinIndex + offset) % VIEW_FOLDERS.length;
      const folder = VIEW_FOLDERS[index]!.id;
      const state = this.state(folder);
      if (!state.complete && !state.blocked) {
        this.roundRobinIndex = (index + 1) % VIEW_FOLDERS.length;
        return folder;
      }
    }
    return null;
  }

  private anyDemandPending(): boolean {
    return VIEW_FOLDERS.some((folder) => this.needsDemand(folder.id));
  }

  /**
   * Releases the account lock to anyone else who wants it. A competing
   * command's `ProcessLock` wait (see core/lock.ts) polls far more often
   * than this, so one pause is enough for it to get in.
   */
  private async pauseBetweenBackgroundChunks(): Promise<void> {
    const pauseMs = this.options.backgroundPauseMs ?? VIEW_BACKGROUND_CHUNK_PAUSE_MS;
    if (pauseMs <= 0) return;
    try {
      await delay(pauseMs, undefined, { signal: this.abortController.signal });
    } catch {
      // Aborted by stop(); the pump's own loop condition ends the walk.
    }
  }

  private hasWork(): boolean {
    if (this.stopped || this.fatalError) return false;
    const hasIncompleteDemand = VIEW_FOLDERS.some((folder) => this.needsDemand(folder.id));
    const hasIncompleteBackgroundFolder =
      this.backgroundEnabled && [...this.states.values()].some((state) => !state.complete && !state.blocked);
    return hasIncompleteDemand || hasIncompleteBackgroundFolder ||
      (this.backgroundEnabled && !this.finished && this.allFoldersComplete());
  }

  private kick(): void {
    if (this.running || !this.hasWork()) return;
    this.running = this.pump()
      .catch((error: unknown) => {
        this.fatalError = error;
      })
      .finally(() => {
        this.running = null;
        this.notify();
        if (this.hasWork()) this.kick();
      });
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const folder = this.nextFolder();
      if (!folder) break;
      // A chunk someone is actively waiting for runs back-to-back; one that
      // is only filling the cache ahead of time gives the account lock up
      // for a moment first (see VIEW_BACKGROUND_CHUNK_PAUSE_MS).
      const servingDemand = this.needsDemand(folder);
      await this.loadNextPage(folder);
      this.notify();
      if (!servingDemand && !this.stopped && !this.anyDemandPending()) {
        await this.pauseBetweenBackgroundChunks();
      }
    }
    if (!this.stopped && this.backgroundEnabled && this.allFoldersComplete()) {
      await this.finalizeCompleteSnapshot();
    }
  }

  private async ensureProfile(): Promise<{ emailAddress: string; historyId: string }> {
    if (this.profile) return this.profile;
    this.profile = await this.runBackgroundExclusive(
      () => {
        // Capture the protection horizon only once the scan can really begin,
        // under the same account lock as its Gmail profile fence.
        this.snapshotStartedAt ??= this.options.nowIso();
        return fetchProfile(this.options.gmailClient, this.abortController.signal);
      }
    );
    return this.profile;
  }

  /**
   * Retries account-lock contention without holding the coordinator queue,
   * but only within a bounded budget.
   *
   * An unbounded retry here is indistinguishable from a hang: the caller
   * that is awaiting the first chunk never gets a result, an error, or a
   * wake-up. Each attempt now notifies waiters (so a caller with its own
   * timeout can give up and draw the screen) and the budget eventually
   * converts contention into a normal, reportable failure.
   */
  private async runBackgroundExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + VIEW_LOCK_WAIT_BUDGET_MS;
    for (;;) {
      this.abortController.signal.throwIfAborted();
      try {
        const result = await this.options.runExclusive(operation, this.abortController.signal);
        this.lockContended = false;
        return result;
      } catch (error) {
        if (!(error instanceof ViewBackgroundLockBusyError)) throw error;
        this.lockContended = true;
        // Let anyone waiting on this folder observe the stall and decide
        // for themselves whether to keep waiting.
        this.notify();
        if (Date.now() >= deadline) {
          throw new SafetyPreconditionError(
            "Another gmail process is holding this account's lock, so mail could not be loaded right now. " +
              'Wait for it to finish and press "u" to retry.'
          );
        }
        await delay(VIEW_LOCK_RETRY_MS, undefined, { signal: this.abortController.signal });
      }
    }
  }

  private async loadNextPage(folder: ViewFolderId): Promise<void> {
    const state = this.state(folder);
    const profile = await this.ensureProfile();
    const demand = this.demand.get(folder);
    const demandActive = this.needsDemand(folder);
    const demandReadRemaining = Math.max(1, (demand?.listedLimit ?? state.listed + this.chunkSize) - state.listed);
    // Never larger than one UI page, even when the demand is for several:
    // the account lock is held for the whole chunk, so a multi-page request
    // is better served by several short chunks than by one long one.
    const maxResults = demandActive
      ? Math.max(1, Math.min(500, this.chunkSize, demandReadRemaining))
      : this.chunkSize;
    const definition = viewFolderDefinition(folder);

    try {
      await this.runBackgroundExclusive(async () => {
        const page = await listMessagePage(this.options.gmailClient, {
          ...definition.list,
          maxResults,
          signal: this.abortController.signal,
          ...(state.started && state.nextPageToken ? { pageToken: state.nextPageToken } : {})
        });
        state.started = true;
        if (state.estimatedTotal === null) state.estimatedTotal = page.estimatedTotal;

        const stubs = page.messages.filter((stub) => {
          if (state.seenIds.has(stub.id)) return false;
          state.seenIds.add(stub.id);
          return true;
        });
        state.listed += stubs.length;
        await this.hydratePage(profile.emailAddress, folder, stubs);

        if (page.nextPageToken) {
          if (state.seenPageTokens.has(page.nextPageToken)) {
            throw new Error(`Gmail repeated a ${folder} message-list page token.`);
          }
          state.seenPageTokens.add(page.nextPageToken);
          state.nextPageToken = page.nextPageToken;
        } else {
          state.nextPageToken = null;
          state.complete = true;
        }
      });
    } catch (error) {
      state.failed += 1;
      state.blocked = true;
      if (!this.fatalError) this.fatalError = error;
    }

    this.options.onCacheChanged?.(folder);
  }

  private async hydratePage(userEmail: string, _folder: ViewFolderId, stubs: readonly MessageStub[]): Promise<void> {
    if (stubs.length === 0) return;
    const messages = new MessagesRepository(this.options.db);
    const records: CachedMessageRecord[] = [];
    const deletedIds: string[] = [];

    await mapWithConcurrency(stubs, VIEW_CACHE_READ_CONCURRENCY, async (stub) => {
      try {
        const raw = await fetchMessageFull(this.options.gmailClient, stub.id, this.abortController.signal);
        const existing = messages.get(this.options.account.accountHash, stub.id);
        const projection = projectHydratedCacheMessage(
          this.options.account.accountHash,
          userEmail,
          this.options.nowIso(),
          stub,
          raw,
          existing,
          "view"
        );
        if (projection) {
          records.push(projection);
          this.activeIds.add(stub.id);
        } else {
          deletedIds.push(stub.id);
        }
      } catch (error) {
        if (apiErrorStatus(error) === 404) deletedIds.push(stub.id);
        else this.state(_folder).failed += 1;
      }
    });

    try {
      messages.applyCacheBatch(this.options.account.accountHash, records, deletedIds);
    } catch {
      this.state(_folder).failed += records.length + deletedIds.length;
    }
  }

  private allFoldersComplete(): boolean {
    return [...this.states.values()].every((state) => state.complete);
  }

  private async finalizeCompleteSnapshot(): Promise<void> {
    if (this.finished || !this.profile) return;
    const failed = [...this.states.values()].reduce((sum, state) => sum + state.failed, 0);
    if (failed > 0) {
      this.finished = true;
      this.notify();
      return;
    }

    await this.runBackgroundExclusive(async () => {
      this.options.db.transaction(() => {
        const settings = new SettingsRepository(this.options.db);
        const persistedViewMarker = settings.get(
          this.options.account.accountHash,
          SETTING_KEYS.viewHistoryMarker
        );
        // A competing viewer already certified an equal or newer complete
        // snapshot. This older pass must not prune its rows or move its fence
        // backwards; the existing complete snapshot satisfies our goal.
        if (
          persistedViewMarker &&
          !historyIdGreaterThan(this.profile!.historyId, persistedViewMarker)
        ) {
          return;
        }

        const messages = new MessagesRepository(this.options.db);
        const snapshotStartedAtMs = Date.parse(this.snapshotStartedAt ?? "");
        const staleIds = messages
          .listForAccount(this.options.account.accountHash)
          .filter((row) => {
            if (!isViewCacheMessage(row.labelSnapshot) || this.activeIds.has(row.gmailMessageId)) {
              return false;
            }
            const processedAtMs = Date.parse(row.processedAt);
            const changedSinceSnapshotStarted =
              Number.isFinite(snapshotStartedAtMs) &&
              Number.isFinite(processedAtMs) &&
              processedAtMs >= snapshotStartedAtMs;
            return !changedSinceSnapshotStarted;
          })
          .map((row) => row.gmailMessageId);
        for (const staleId of staleIds) {
          messages.delete(this.options.account.accountHash, staleId);
        }

        const completedAt = this.options.nowIso();
        const accounts = new AccountsRepository(this.options.db);
        const latestAccount = accounts.get(this.options.account.accountHash);
        if (
          !latestAccount?.historyMarker ||
          historyIdGreaterThan(this.profile!.historyId, latestAccount.historyMarker)
        ) {
          accounts.updateHistoryMarker(this.options.account.accountHash, this.profile!.historyId, completedAt);
        }
        settings.set(
          this.options.account.accountHash,
          SETTING_KEYS.viewHistoryMarker,
          this.profile!.historyId,
          completedAt
        );
        settings.set(
          this.options.account.accountHash,
          SETTING_KEYS.viewFullCacheAt,
          completedAt,
          completedAt
        );
        settings.set(
          this.options.account.accountHash,
          SETTING_KEYS.viewLastRefreshAt,
          completedAt,
          completedAt
        );
      })();
    });
    this.finished = true;
    this.completedSuccessfully = true;
    this.notify();
  }

  private notify(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }
}
