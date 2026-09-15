import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { openUrlInBrowser as openUrlInSystemBrowser } from "../core/open-browser.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { latestCacheRefreshAt, runWork, type WorkAppliedBatch } from "./work.js";
import { MessagesRepository, type CachedMessageRecord } from "../state/repositories/messages.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { fetchMessageFull, headersFromMessage } from "../gmail/scanner.js";
import { buildNormalizedMessage, extractBodyParts } from "../gmail/normalize.js";
import { GMAIL_LABELS, isRead } from "../gmail/labels.js";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../core/terminal-text.js";
import { buildReplyTarget } from "../gmail/reply.js";
import { draftReply } from "../ai/draft-reply.js";
import { resolveOpenAiCredentials } from "../ai/resolve-classifier.js";
import type { ResolvedOpenAiCredentials } from "../ai/resolve-classifier.js";
import { promptBody, reviewAiDraft, confirmAndSend, handleCompose } from "../gmail/compose-flow.js";
import { readCommandLine, waitForKeypress } from "../core/keypress.js";
import { lockFilePath } from "../config/paths.js";
import { EXIT_CODES } from "../core/errors.js";
import { trashMessage, untrashMessage, modifyMessageLabels } from "../gmail/executor.js";
import type { GmailClient } from "../gmail/client.js";
import type { NormalizedMessage } from "../core/models.js";
import { projectHydratedCacheMessage } from "../gmail/cache-projection.js";
import { refreshViewCache } from "../gmail/view-sync.js";
import { listUserLabels } from "../gmail/custom-labels.js";
import { getWritingStyleProfile } from "../gmail/writing-style.js";
import {
  ProgressiveViewCache,
  VIEW_INITIAL_PAGE_COUNT,
  ViewOperationCoordinator,
  type ViewExclusiveRunner
} from "../gmail/view-cache.js";
import {
  SINGLE_ROW_ACTIONS,
  parseCursorMotion,
  parseRowCommand,
  parseRowSelector,
  resolveRowsOnPage,
  type ViewRowAction
} from "./view-commands.js";
import {
  VIEW_FOLDERS,
  adjacentViewFolder,
  folderForLabelSnapshot,
  messageIsInViewFolder,
  viewFolderSupportsSearch,
  type ViewFolderId
} from "../gmail/view-folders.js";

export interface ViewOptions {
  limit?: number;
  /** Use the existing cache immediately instead of reconciling Gmail history on startup. */
  previous?: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_STEPS = [5, 10, 20, 50, 100] as const;

/**
 * How long startup waits for the first mail before opening the interface
 * anyway. There is nothing to show yet, so it is worth waiting a little —
 * but never indefinitely: a loader blocked behind another `gmail`
 * process's account lock used to leave the terminal with no list, no
 * prompt, and no error at all, which is indistinguishable from a crash.
 */
const VIEW_STARTUP_WAIT_MS = 10_000;

/**
 * How long a keystroke waits for mail that is not cached yet. Short on
 * purpose: switching folders or turning a page must always redraw
 * promptly, showing whatever is cached and letting the rest arrive in the
 * background, rather than holding the whole UI until Gmail answers.
 */
const VIEW_NAVIGATION_WAIT_MS = 2_500;

/**
 * How much of a message body the read view renders.
 *
 * Deliberately far larger than the classifier's own cap: that one exists to
 * bound what is sent to a model, and reusing it here meant a long message
 * simply stopped mid-sentence on screen with nothing to say it had. This is
 * still a bound — a terminal is not the place to dump an unbounded string —
 * but one a real email essentially never reaches, and `renderMessage` says
 * so explicitly when it does.
 */
const VIEW_READ_BODY_CHARS = 200_000;

/**
 * How many consecutive failed loop iterations end the session.
 *
 * A caught error keeps the viewer alive, which is the point; but if what is
 * failing is the render or the prompt itself, retrying forever would spin
 * invisibly instead of reporting anything. A handful of attempts
 * distinguishes "that command did not work" from "this terminal is gone".
 */
const MAX_CONSECUTIVE_VIEW_FAILURES = 5;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function viewFolderLabel(folder: ViewFolderId): string {
  return VIEW_FOLDERS.find((candidate) => candidate.id === folder)!.label;
}

const LIST_CONTROLS =
  "↑/↓ or j/k select · <n>j/<n>k jump n rows · shift+↑/↓ select several · enter or <n> open · " +
  "d confirm delete · dd delete without asking · i move to Inbox · s star/unstar · r/;r reply/AI-reply · " +
  'every row action takes rows: "d 3-5", "s 1,4", "3-5 dd", or acts on the selection · ' +
  "←/→ folders · n/p page · [ ] history · esc home · +/- size · l <n> · f filter · /<text> Inbox search · " +
  "c/a compose · ;s refresh writing style · ;u undo last delete · u refresh · " +
  "gmail [--limit n] clean up now · q quit";

/**
 * Wipes the viewport *and* the scrollback so paging or moving between
 * messages replaces what is on screen instead of appending yet another copy
 * below it. Anything the user still needs to see after a redraw is passed
 * through as a `notice` rather than left in the scrollback to be erased.
 */
function clearScreen(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

interface ListViewSnapshot {
  folder: ViewFolderId;
  page: number;
  pageSize: number;
  selectedTags: Set<string>;
  search: string;
  /** Restored with the rest of the view so "[" lands the cursor back where it was. */
  selectedRow: number;
}

/** `gmail view` — an interactive four-folder terminal mail view with live incremental refresh. */
export async function runView(options: ViewOptions): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error(pc.red("gmail view is interactive and requires a terminal (stdin is not a TTY)."));
    return EXIT_CODES.safetyBlocked;
  }

  const ctx = bootstrap();
  let { account, gmailClient } = await resolveAccountSigningInIfNeeded(ctx);
  const messagesRepo = new MessagesRepository(ctx.db);
  const initialCachedCount = messagesRepo.countForAccount(account.accountHash);
  let pageSize = options.limit ?? DEFAULT_PAGE_SIZE;
  const operations = new ViewOperationCoordinator(lockFilePath(account.accountHash));
  const progressiveCache: { current: ProgressiveViewCache | null } = { current: null };
  const retainInProgressiveSnapshot = (messageId: string): void => {
    progressiveCache.current?.retainId(messageId);
  };
  const beginProgressiveCache = async (folder: ViewFolderId): Promise<void> => {
    if (progressiveCache.current) await progressiveCache.current.stop();
    account = new AccountsRepository(ctx.db).get(account.accountHash) ?? account;
    progressiveCache.current = new ProgressiveViewCache({
      db: ctx.db,
      gmailClient,
      account,
      nowIso: () => ctx.clock.nowIso(),
      pageSize,
      runExclusive: operations.runExclusive
    });
    const desired = pageSize * VIEW_INITIAL_PAGE_COUNT;
    const alreadyCached = messagesRepo
      .listForAccount(account.accountHash)
      .filter((message) => messageIsInViewFolder(message.labelSnapshot, folder)).length;
    console.error(
      pc.dim(
        alreadyCached >= desired
          ? `Opening the cached ${viewFolderLabel(folder)}; refreshing all folders in the background.`
          : `Loading up to the first ${VIEW_INITIAL_PAGE_COUNT} ${viewFolderLabel(folder)} page(s)...`
      )
    );
    const status = await progressiveCache.current.ensureFolder(folder, desired, {
      timeoutMs: VIEW_STARTUP_WAIT_MS
    });
    if (progressiveCache.current.waitingForAccountLock) {
      console.error(
        pc.yellow(
          "Another gmail command is running, so loading is waiting for it to finish. " +
            'Opening with the mail already cached; press "u" to retry once it is done.'
        )
      );
    } else if (status.failed > 0 || progressiveCache.current.error) {
      console.error(pc.yellow("Some mail could not be loaded; the cached rows that succeeded are still available."));
    } else if (status.cached < desired && !status.complete) {
      console.error(pc.dim("Opening now; the rest of this folder keeps loading in the background."));
    }
    // Do not await this: remaining pages and folders are deliberately filled
    // while the user is already browsing the initial rows.
    progressiveCache.current.startBackground();
  };

  let refresh: Awaited<ReturnType<typeof refreshViewCache>> | null = null;
  let startupNotice: string | null = null;
  if (options.previous) {
    console.error(pc.dim("Using the previous Gmail cache without refreshing it."));
  } else {
    try {
      // `gmail cache`'s own full-snapshot timestamp and gmail view's own
      // incremental-refresh timestamp are tracked separately (see
      // gmail/view-sync.ts), but whichever happened more recently is what
      // actually answers "how stale is what I'm about to show" — showing
      // only the `gmail cache`-specific one made a view session that had
      // been refreshing itself the whole time (via "u" or on every launch)
      // still claim to be looking at data from whenever `gmail cache` last
      // ran, however long ago that was.
      const lastSyncAt = latestCacheRefreshAt(ctx.db, account.accountHash);
      console.error(pc.dim(lastSyncAt ? `Updating mail cached ${formatAge(lastSyncAt)}...` : "Updating cached mail..."));

      refresh = await operations.runExclusive(() => refreshViewCache(ctx.db, gmailClient, account, ctx.clock.nowIso()));
      if (refresh.kind === "full_required") {
        console.error(
          pc.dim(
            (initialCachedCount > 0
              ? `The cache contains ${initialCachedCount} message(s), but the four-folder view has no usable history checkpoint. `
              : "There is no four-folder view cache yet. ") +
              `Loading only the first ${VIEW_INITIAL_PAGE_COUNT} Inbox pages before opening; the rest will continue in the background.`
          )
        );
        await beginProgressiveCache("inbox");
      } else if (refresh.added + refresh.updated + refresh.removed > 0 || refresh.failed > 0) {
        console.error(
          pc.dim(
            `Mail updated: ${refresh.added} new, ${refresh.updated} changed, ${refresh.removed} removed` +
              (refresh.failed > 0 ? `, ${refresh.failed} will retry later` : "") + "."
          )
        );
      } else {
        console.error(pc.dim("Mail is up to date."));
      }
    } catch (error) {
      // A cache-first viewer that refuses to open because Gmail is
      // unreachable has its failure mode backwards: the mail it was about
      // to show is already on disk. Report the refresh failure and open
      // anyway — the same place `--previous` deliberately starts from —
      // instead of exiting to a stack trace. "u" retries.
      startupNotice = `Could not refresh from Gmail: ${describeError(error)}. Showing the mail already cached; "u" retries.`;
      console.error(pc.yellow(startupNotice));
    }
  }

  let all = messagesRepo.listForAccount(account.accountHash);
  if (options.previous && all.length === 0) {
    console.log(pc.yellow("The previous cache is empty. Run `gmail view` without --previous to load mail."));
    return EXIT_CODES.ok;
  }

  let labelNames = options.previous ? systemLabelNames() : await loadLabelNames(gmailClient);
  let activeFolder: ViewFolderId = "inbox";
  let selectedTags = new Set<string>();
  let search = "";
  let page = 0;
  /** Highlighted row within the current page — moved by ↑/↓ or j/k, opened by Enter on an empty command. */
  let selectedRow = 0;
  /**
   * Page-row indexes selected by shift+↑/↓ or by a bare row selector
   * ("3-5"), which a bare row action then acts on instead of the single
   * highlighted row. Empty means "just the highlighted row".
   */
  let selection = new Set<number>();
  /** Where a shift+arrow run started, so extending it stays anchored while the cursor moves. */
  let selectionAnchor: number | null = null;
  /**
   * The messages trashed by the most recent delete in this session, for the
   * ";u" quick undo. A list rather than one record because a single "dd 3-5"
   * is still one delete from the user's point of view, and undoing only the
   * last of its five messages would be a worse surprise than not offering
   * undo at all.
   */
  let lastTrashed: CachedMessageRecord[] = [];
  const backStack: ListViewSnapshot[] = [];
  const forwardStack: ListViewSnapshot[] = [];
  const snapshotView = (): ListViewSnapshot => ({
    folder: activeFolder,
    page,
    pageSize,
    selectedTags: new Set(selectedTags),
    search,
    selectedRow
  });
  /** Navigation and every applied row action drop the selection: it indexes rows on one specific page. */
  const clearSelection = (): void => {
    selection = new Set();
    selectionAnchor = null;
  };
  const restoreView = (snapshot: ListViewSnapshot): void => {
    clearSelection();
    activeFolder = snapshot.folder;
    page = snapshot.page;
    if (snapshot.pageSize !== pageSize) {
      pageSize = snapshot.pageSize;
      progressiveCache.current?.setPageSize(pageSize);
    }
    selectedTags = new Set(snapshot.selectedTags);
    search = snapshot.search;
    selectedRow = snapshot.selectedRow;
  };
  const rememberView = (): void => {
    clearSelection();
    backStack.push(snapshotView());
    if (backStack.length > 50) backStack.shift();
    forwardStack.length = 0;
  };
  /** The one page-size change, shared by "+"/"-" and "l <n>" so they cannot drift. */
  const applyPageSize = async (nextSize: number): Promise<void> => {
    if (nextSize === pageSize) return;
    // Keep the message that was at the top of the page in view.
    const firstVisibleIndex = page * pageSize;
    rememberView();
    pageSize = nextSize;
    page = Math.floor(firstVisibleIndex / pageSize);
    selectedRow = 0;
    // The loader's chunk is one UI page, so it has to learn the new size
    // too; otherwise a widened page is filled by several short round trips,
    // each taking and releasing the account lock.
    progressiveCache.current?.setPageSize(pageSize);
    await progressiveCache.current?.ensureFolder(activeFolder, (page + 1) * pageSize, {
      timeoutMs: VIEW_NAVIGATION_WAIT_MS
    });
  };
  // Saved once to SQLite (see gmail/writing-style.ts) instead of being
  // re-derived from a live Sent-mail fetch on every single AI draft/reply —
  // a settings-table read is essentially free, so no additional in-memory
  // caching is needed here; ";s" forces a real recomputation on demand.
  const getStyleProfile = (credentials: ResolvedOpenAiCredentials, forceRefresh = false): Promise<string | null> =>
    getWritingStyleProfile(
      {
        config: ctx.config,
        db: ctx.db,
        accountHash: account.accountHash,
        gmailClient,
        userEmail: account.emailDisplay ?? "",
        credentials,
        nowIso: () => ctx.clock.nowIso()
      },
      forceRefresh
    );

  let notice: string | null = startupNotice;
  let consecutiveFailures = 0;
  try {
    for (;;) {
      try {
        // Background hydration never writes to the active prompt. Refreshing the
        // local snapshot at each redraw makes its newly committed rows appear on
        // the next user interaction without racing terminal output.
        all = messagesRepo.listForAccount(account.accountHash);
        const folderMessages = all.filter((message) => messageIsInViewFolder(message.labelSnapshot, activeFolder));
        const visible = filterMessages(folderMessages, selectedTags, viewFolderSupportsSearch(activeFolder) ? search : "");
        const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
        page = Math.min(page, totalPages - 1);
        const pageItems = visible.slice(page * pageSize, (page + 1) * pageSize);
        selectedRow = pageItems.length === 0 ? 0 : Math.min(selectedRow, pageItems.length - 1);
        // A shorter page (a delete, a smaller page size) can leave selected
        // indexes pointing past the end; drop those rather than resolving
        // them to whatever moved up into their place.
        for (const index of [...selection]) if (index >= pageItems.length) selection.delete(index);
        /** j/k and their counted forms. Stops at the page edge instead of wrapping, so "20j" lands on the last row. */
        const moveCursor = (direction: "up" | "down", count: number): void => {
          if (pageItems.length === 0) return;
          clearSelection();
          const delta = direction === "down" ? count : -count;
          selectedRow = Math.min(pageItems.length - 1, Math.max(0, selectedRow + delta));
        };
        /** The rows a bare row action applies to: the shift+arrow selection, or the highlighted row. */
        const currentSelection = (): number[] => {
          if (pageItems.length === 0) return [];
          if (selection.size === 0) return [selectedRow];
          return [...selection].sort((left, right) => left - right);
        };
        /** Opens one message, staying in the read view across prev/next until the user backs out. */
        const openSelectedMessage = async (cached: CachedMessageRecord): Promise<{ notice: string | null }> => {
          let messageIndex = visible.indexOf(cached);
          if (messageIndex === -1) messageIndex = 0;
          let openedNotice: string | null = null;
          for (;;) {
            const opened = await openMessage(
              gmailClient,
              account.accountHash,
              account.emailDisplay ?? "",
              visible[messageIndex]!,
              ctx,
              getStyleProfile,
              messageIndex > 0,
              messageIndex < visible.length - 1,
              operations.runExclusive,
              retainInProgressiveSnapshot
            );
            openedNotice = opened.notice;
            if (opened.trashedRecord) lastTrashed = [opened.trashedRecord];
            if (opened.navigation === "previous") messageIndex -= 1;
            else if (opened.navigation === "next") messageIndex += 1;
            else break;
          }
          all = messagesRepo.listForAccount(account.accountHash);
          return { notice: openedNotice };
        };

        /**
         * Applies one row action to the rows the user selected, whether
         * that was a selector ("d 3-5"), a shift+arrow selection, or the
         * highlighted row. Single-message actions are guaranteed by the
         * caller to arrive with exactly one target, so nothing here can turn
         * one confirmation into several sends. Returns the notice for the
         * next render rather than printing it, since the redraw would erase
         * anything written now.
         */
        const applyRowAction = async (
          action: ViewRowAction,
          targets: readonly CachedMessageRecord[]
        ): Promise<string | null> => {
          if (action === "open") {
            const opened = await openSelectedMessage(targets[0]!);
            return opened.notice;
          }
          if (action === "reply" || action === "ai_reply") {
            const opened = await openMessage(
              gmailClient,
              account.accountHash,
              account.emailDisplay ?? "",
              targets[0]!,
              ctx,
              getStyleProfile,
              false,
              false,
              operations.runExclusive,
              retainInProgressiveSnapshot,
              action
            );
            if (opened.trashedRecord) lastTrashed = [opened.trashedRecord];
            return opened.notice;
          }
          if (action === "star") {
            // Toggle, as a mail client's star always is. "All of them are
            // starred" is the only state where the obvious next intent is to
            // unstar; a mixed selection stars the rest, which is what the
            // user pressing "s" over it was asking for.
            const starred = !targets.every((target) => target.labelSnapshot.includes(GMAIL_LABELS.starred));
            const outcome = await operations.runExclusive(() =>
              applyToTargets(targets, (target) =>
                setCachedStar(gmailClient, messagesRepo, target, starred, ctx.clock.nowIso())
              )
            );
            for (const record of outcome.done) retainInProgressiveSnapshot(record.gmailMessageId);
            return summarizeBulk(
              outcome,
              (record) => `${starred ? "Starred" : "Unstarred"} ${quoteSubject(record)}.`,
              (count) => `${starred ? "Starred" : "Unstarred"} ${count} messages.`
            );
          }
          if (action === "move_to_inbox") {
            const outcome = await operations.runExclusive(() =>
              applyToTargets(targets, (target) =>
                moveCachedToInbox(gmailClient, messagesRepo, target, ctx.clock.nowIso())
              )
            );
            for (const record of outcome.done) retainInProgressiveSnapshot(record.gmailMessageId);
            return summarizeBulk(
              outcome,
              (record) => `Moved ${quoteSubject(record)} to Inbox.`,
              (count) => `Moved ${count} messages to Inbox.`
            );
          }
          // Trash, with or without the question in front of it. Both share
          // one implementation so they cannot diverge on what deleting does
          // (always Gmail's reversible Trash, never a permanent delete), and
          // "d" keeps its "press any key" hold while "dd" deliberately has
          // none — see CLAUDE.md.
          const deletable = targets.filter(
            (target) => folderForLabelSnapshot(target.labelSnapshot) !== "trash"
          );
          if (deletable.length === 0) {
            return "Already in Trash; permanent deletion is never supported.";
          }
          if (action === "delete" && !(await confirmTrash(deletable))) {
            console.log(pc.dim("Not deleted."));
            console.log(pc.dim("\nPress any key to return to the list."));
            await waitForKeypress();
            return null;
          }
          const outcome = await operations.runExclusive(() =>
            applyToTargets(deletable, (target) =>
              trashCached(gmailClient, messagesRepo, target, ctx.clock.nowIso())
            )
          );
          for (const record of outcome.done) retainInProgressiveSnapshot(record.gmailMessageId);
          if (outcome.done.length > 0) lastTrashed = outcome.done;
          const summary = summarizeBulk(
            outcome,
            (record) => `Moved ${quoteSubject(record)} to Trash. ";u" undoes it.`,
            (count) => `Moved ${count} messages to Trash. ";u" undoes them.`,
            targets.length > deletable.length
              ? `${targets.length - deletable.length} already in Trash and left alone.`
              : undefined
          );
          if (action === "delete") {
            if (summary) console.log(pc.green(sanitizeTerminalText(summary)));
            console.log(pc.dim("\nPress any key to return to the list."));
            await waitForKeypress();
          }
          return summary;
        };

        renderList(pageItems, {
          folder: activeFolder,
          folderCounts: countViewFolders(all),
          folderLoad: progressiveCache.current?.status(activeFolder) ?? null,
          backgroundError: progressiveCache.current?.error !== null && progressiveCache.current?.error !== undefined,
          waitingForAccountLock: progressiveCache.current?.waitingForAccountLock ?? false,
          page,
          totalPages,
          pageSize,
          total: visible.length,
          selectedTags,
          search: viewFolderSupportsSearch(activeFolder) ? search : "",
          labelNames,
          notice,
          selectedRow,
          selection
        });
        notice = null;
        const input = await readCommandLine("> ", ["left", "right", "up", "down", "j", "k"]);
        // Rendering and reading both worked, so whatever failed last time was
        // the command, not the terminal. Only an unbroken run of failures
        // ends the session.
        consecutiveFailures = 0;
        if (input.kind === "cancel") {
          // Esc always goes "home" (default Inbox filter, no search, first
          // page) instead of quitting — quitting is q/Ctrl-C only. Useful
          // after a search or a deep filter/page-history dive. It also
          // always drops a row selection, which is what esc means to anyone
          // who has selected the wrong rows.
          clearSelection();
          if (activeFolder !== "inbox" || search || selectedTags.size > 0 || page !== 0) {
            rememberView();
            activeFolder = "inbox";
            search = "";
            selectedTags = new Set();
            page = 0;
            selectedRow = 0;
            if (progressiveCache.current) {
              await progressiveCache.current.ensureFolder("inbox", pageSize, {
                timeoutMs: VIEW_NAVIGATION_WAIT_MS
              });
            }
          }
          continue;
        }
        if (input.kind === "key") {
          if (input.name === "j" || input.name === "k") {
            // The bare vim motions answer instantly, like the arrows. Their
            // counted forms ("5j") have to be typed and submitted, since the
            // digits have to be read before the motion means anything.
            moveCursor(input.name === "j" ? "down" : "up", 1);
            continue;
          }
          if (input.name === "up" || input.name === "down") {
            if (pageItems.length > 0) {
              if (input.shift) {
                // Shift extends a selection anchored where the run started,
                // and deliberately stops at the ends instead of wrapping:
                // wrapping would quietly turn "the next three" into "every
                // row except two".
                if (selectionAnchor === null) selectionAnchor = selectedRow;
                selectedRow = Math.min(
                  pageItems.length - 1,
                  Math.max(0, selectedRow + (input.name === "up" ? -1 : 1))
                );
                const from = Math.min(selectionAnchor, selectedRow);
                const to = Math.max(selectionAnchor, selectedRow);
                selection = new Set(Array.from({ length: to - from + 1 }, (_, offset) => from + offset));
              } else {
                clearSelection();
                selectedRow =
                  input.name === "up"
                    ? (selectedRow - 1 + pageItems.length) % pageItems.length
                    : (selectedRow + 1) % pageItems.length;
              }
            }
            continue;
          }
          if (input.name !== "left" && input.name !== "right") continue;
          rememberView();
          activeFolder = adjacentViewFolder(activeFolder, input.name);
          page = 0;
          selectedRow = 0;
          selectedTags = new Set();
          // Search is intentionally Inbox-only for now; changing folders clears
          // it instead of pretending a partial local cache is a mailbox search.
          search = "";
          // One page is all a folder switch needs to draw; the rest of
          // Archive/Trash/Spam keeps filling in behind the prompt.
          if (progressiveCache.current) {
            await progressiveCache.current.ensureFolder(activeFolder, pageSize, {
              timeoutMs: VIEW_NAVIGATION_WAIT_MS
            });
          }
          continue;
        }
        const cmd = input.value.trim();

        if (cmd === "q") break;
        if (cmd === "") {
          // Enter on an empty command opens the highlighted row — the ↑/↓
          // selection cursor's counterpart to typing a number and pressing Enter.
          if (pageItems.length === 0) continue;
          const opened = await openSelectedMessage(pageItems[selectedRow]!);
          notice = opened.notice;
          continue;
        }
        if (cmd === "n") {
          if (progressiveCache.current) {
            const status = progressiveCache.current.status(activeFolder);
            const desired = search || selectedTags.size > 0
              ? status.cached + pageSize
              : (page + 2) * pageSize;
            await progressiveCache.current.ensureFolder(activeFolder, desired, {
              timeoutMs: VIEW_NAVIGATION_WAIT_MS
            });
            all = messagesRepo.listForAccount(account.accountHash);
          }
          const refreshedVisible = filterMessages(
            all.filter((message) => messageIsInViewFolder(message.labelSnapshot, activeFolder)),
            selectedTags,
            viewFolderSupportsSearch(activeFolder) ? search : ""
          );
          const refreshedTotalPages = Math.max(1, Math.ceil(refreshedVisible.length / pageSize));
          if (page < refreshedTotalPages - 1) {
            rememberView();
            page += 1;
            selectedRow = 0;
          } else {
            notice = progressiveCache.current?.status(activeFolder).complete
              ? "Already at the last page in this folder."
              : "No additional cached messages are available yet.";
          }
          continue;
        }
        if (cmd === "p") {
          if (page > 0) {
            rememberView();
            page -= 1;
            // Same as "n": a new page starts at its first row rather than
            // wherever the cursor happened to sit on the page just left.
            selectedRow = 0;
          } else {
            notice = "Already at the first page in this folder.";
          }
          continue;
        }
        if (cmd === "[") {
          const previous = backStack.pop();
          if (previous) {
            forwardStack.push(snapshotView());
            restoreView(previous);
            if (progressiveCache.current) {
              await progressiveCache.current.ensureFolder(activeFolder, (page + 1) * pageSize, {
                timeoutMs: VIEW_NAVIGATION_WAIT_MS
              });
            }
          } else {
            notice = "No earlier view.";
          }
          continue;
        }
        if (cmd === "]") {
          const next = forwardStack.pop();
          if (next) {
            backStack.push(snapshotView());
            restoreView(next);
            if (progressiveCache.current) {
              await progressiveCache.current.ensureFolder(activeFolder, (page + 1) * pageSize, {
                timeoutMs: VIEW_NAVIGATION_WAIT_MS
              });
            }
          } else {
            notice = "No later view.";
          }
          continue;
        }
        if (cmd === "+" || cmd === "-") {
          await applyPageSize(adjustPageSize(pageSize, cmd === "+" ? "larger" : "smaller"));
          continue;
        }
        const limitMatch = /^l\s+(\d+)$/.exec(cmd);
        if (limitMatch) {
          await applyPageSize(Math.max(1, Number(limitMatch[1])));
          continue;
        }
        if (cmd === "f" || cmd === "t") {
          const nextTags = await chooseTags(collectDistinctTags(folderMessages), selectedTags, labelNames);
          if (!sameSet(nextTags, selectedTags)) {
            rememberView();
            selectedTags = nextTags;
            page = 0;
          }
          continue;
        }
        // Search is "/text" (bare "/" clears it) rather than the "s text" it
        // used to be: "s" is now the star action, and "s 2024" has to mean
        // one unambiguous thing. "/" is also what the vim-style motions this
        // list accepts would lead anyone to try first.
        if (cmd.startsWith("/")) {
          if (!viewFolderSupportsSearch(activeFolder)) {
            notice = "Search is currently available only in Inbox.";
            continue;
          }
          const nextSearch = cmd.slice(1).trim();
          if (nextSearch !== search) {
            rememberView();
            search = nextSearch;
            page = 0;
            selectedRow = 0;
          }
          continue;
        }
        if (cmd === "u") {
          if (progressiveCache.current) {
            await progressiveCache.current.stop();
            progressiveCache.current = null;
          }
          const latestAccount = new AccountsRepository(ctx.db).get(account.accountHash) ?? account;
          refresh = await operations.runExclusive(() =>
            refreshViewCache(ctx.db, gmailClient, latestAccount, ctx.clock.nowIso())
          );
          if (refresh.kind === "full_required") await beginProgressiveCache(activeFolder);
          account = new AccountsRepository(ctx.db).get(account.accountHash) ?? account;
          all = messagesRepo.listForAccount(account.accountHash);
          labelNames = await loadLabelNames(gmailClient);
          if (page !== 0) {
            rememberView();
            page = 0;
          }
          notice = "Mail updated.";
          continue;
        }
        if (cmd === "c" || cmd === "a" || cmd === ";c") {
          // "c" asks how to write it, exactly as `gmail send` does; "a"/";c"
          // are the shortcut straight to an AI draft.
          await handleCompose(
            gmailClient,
            account.accountHash,
            cmd === "c" ? undefined : true,
            ctx,
            getStyleProfile,
            {},
            operations.runExclusive
          );
          // Hold the send confirmation on screen; the list redraw would wipe it.
          console.log(pc.dim("\nPress any key to return to the list."));
          await waitForKeypress();
          continue;
        }
        if (cmd === ";s") {
          const credentials = await resolveOpenAiCredentials(
            { accountHash: account.accountHash, credentialStore: ctx.credentialStore, config: ctx.config },
            "compose"
          );
          if (!credentials) {
            notice = "AI is not ready; check gmail setup.";
            continue;
          }
          if (credentials.hosted) {
            // The included AI service never receives Sent mail (see
            // gmail/writing-style.ts). Say so plainly rather than running a
            // refresh that would silently produce nothing.
            notice =
              "The included AI service never reads your Sent mail, so there is no style profile to refresh. " +
              "Give drafting instructions when it asks, or switch to your own API key in `gmail setup`.";
            continue;
          }
          const spinner = p.spinner();
          spinner.start("Refreshing your writing style from recent Sent mail");
          const profile = await operations.runExclusive(() => getStyleProfile(credentials, true));
          spinner.stop(profile ? "Writing style saved — future replies/drafts will reuse it." : "Could not derive a writing style from Sent mail.");
          console.log(pc.dim("\nPress any key to return to the list."));
          await waitForKeypress();
          continue;
        }
        if (cmd === ";u") {
          if (lastTrashed.length === 0) {
            notice = "Nothing to undo.";
            continue;
          }
          // Undoes the whole of the last delete, not just its final message:
          // one "dd 3-5" is one delete from where the user is sitting.
          const toRestore = lastTrashed;
          const outcome = await operations.runExclusive(() =>
            applyToTargets(toRestore, async (target) => {
              try {
                await untrashMessage(gmailClient, target.gmailMessageId, target.labelSnapshot);
                // Refresh the projection timestamp so a concurrent progressive
                // snapshot that began before this undo cannot prune the restored
                // row after its folder cursors have already passed it.
                const record = { ...target, processedAt: ctx.clock.nowIso() };
                messagesRepo.upsert(record);
                return { ok: true as const, record };
              } catch (error) {
                return {
                  ok: false as const,
                  message: `Could not undo: ${error instanceof Error ? error.message : String(error)}`
                };
              }
            })
          );
          for (const record of outcome.done) retainInProgressiveSnapshot(record.gmailMessageId);
          all = messagesRepo.listForAccount(account.accountHash);
          // Anything that failed to come back is still in Trash, so keeping
          // it here lets the user simply press ";u" again.
          lastTrashed = outcome.failures.length === 0 ? [] : lastTrashed;
          notice = summarizeBulk(
            outcome,
            (record) => `Restored ${quoteSubject(record)}.`,
            (count) => `Restored ${count} messages.`
          );
          continue;
        }
        const motion = parseCursorMotion(cmd);
        if (motion) {
          moveCursor(motion.direction, motion.count);
          continue;
        }
        // A bare multi-row selector selects those rows without acting on
        // them, so "3-5" then "d" reads the same way as shift+↓↓ then "d".
        // A bare single number stays what it has always been: open it.
        const bareSelector = parseRowSelector(cmd);
        if (bareSelector && bareSelector.length > 1) {
          const indexes = resolveRowsOnPage(bareSelector, pageItems.length);
          if (indexes.length === 0) {
            notice = "No rows on this page match that selection.";
          } else {
            selection = new Set(indexes);
            selectionAnchor = indexes[0]!;
            selectedRow = indexes[indexes.length - 1]!;
          }
          continue;
        }
        // Every row action — open, reply, AI reply, delete, delete-now,
        // move to Inbox, star — goes through one grammar and one dispatcher
        // (see commands/view-commands.ts), so "d 3-5", "3-5 d", and a bare
        // "d" on a shift+arrow selection cannot drift apart in what they
        // accept or what they do. Reply and AI reply still open the message
        // for real and still end at the same unedited confirmation screen:
        // this is a way to choose rows, never a way to skip that screen.
        const rowCommand = parseRowCommand(cmd);
        if (rowCommand) {
          const indexes = rowCommand.rows
            ? resolveRowsOnPage(rowCommand.rows, pageItems.length)
            : currentSelection();
          if (indexes.length === 0) {
            notice =
              pageItems.length === 0
                ? "There are no messages here."
                : "No rows on this page match that selection.";
            continue;
          }
          if (indexes.length > 1 && SINGLE_ROW_ACTIONS.has(rowCommand.action)) {
            notice =
              rowCommand.action === "open"
                ? "Open takes one message at a time."
                : "Replying takes one message at a time — every outbound message is confirmed on its own.";
            continue;
          }
          notice = await applyRowAction(
            rowCommand.action,
            indexes.map((index) => pageItems[index]!)
          );
          clearSelection();
          all = messagesRepo.listForAccount(account.accountHash);
          continue;
        }
        const cleanup = parseCleanupCommand(cmd);
        if (cleanup) {
          // The same cleanup run as `gmail` at a shell prompt, without
          // leaving the session. It goes through `runExclusive`, so it owns
          // the account lock for its whole duration and is serialized
          // against the background cache loader — which is also why
          // `runWork` must not take that lock itself (see
          // `WorkOptions.session`).
          const label =
            "gmail" +
            (cleanup.limit !== undefined ? ` --limit ${cleanup.limit}` : "") +
            (cleanup.archive ? " --archive" : "") +
            (cleanup.dryRun ? " --dry-run" : "");
          clearScreen();
          console.log("");
          console.log(pc.bold(`Running ${label}`));
          console.log(
            pc.dim(
              cleanup.dryRun
                ? "Nothing will be changed; this only reports what a real run would do."
                : "Your mail list will be updated with every change as it is applied."
            )
          );
          console.log("");
          const progressLine = (batch: WorkAppliedBatch): void => {
            const what = batch.kind === "trash" ? "moved to Trash" : "starred/labeled/archived";
            console.error(
              pc.dim(
                `  ${batch.applied} message(s) ${what}` +
                  (batch.failed > 0 ? `, ${batch.failed} failed` : "") +
                  "."
              )
            );
          };
          try {
            const exitCode: number = await operations.runExclusive(() =>
              runWork({
                dryRun: cleanup.dryRun,
                json: false,
                archive: cleanup.archive,
                ...(cleanup.limit !== undefined ? { limit: cleanup.limit } : {}),
                session: { ctx, onAppliedBatch: progressLine }
              })
            );
            notice =
              exitCode === EXIT_CODES.ok
                ? `${label} finished.`
                : `${label} finished with problems (exit code ${exitCode}); see the summary above.`;
          } catch (error) {
            notice = `${label} could not finish: ${describeError(error)}`;
          }
          console.log(pc.dim("\nPress any key to return to the updated list."));
          await waitForKeypress();
          // The run committed its changes through this same SQLite handle,
          // so re-reading here is all it takes for the list — and the Trash
          // and Archive tabs the mail moved to — to show them.
          all = messagesRepo.listForAccount(account.accountHash);
          account = new AccountsRepository(ctx.db).get(account.accountHash) ?? account;
          continue;
        }
        notice = `Unrecognized command: "${cmd}"`;
      } catch (error) {
        // One failed command must not end the session. A Gmail hiccup behind
        // "u", a compose, or a refresh is exactly the situation the local
        // cache exists for: the mail on screen is still readable. Surface it
        // where every other outcome is surfaced — as a notice on the next
        // render — instead of unwinding to a stack trace.
        notice = `Something went wrong: ${describeError(error)}`;
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_VIEW_FAILURES) throw error;
      }
    }
  } finally {
    await progressiveCache.current?.stop();
    await operations.whenIdle();
  }
  return EXIT_CODES.ok;
}

export interface CleanupCommand {
  /** `--limit N`, or undefined for an uncapped run. */
  limit?: number;
  /** `--dry-run`: scan and report, changing nothing. */
  dryRun: boolean;
  /** `--archive`: also take read mail out of the Inbox. */
  archive: boolean;
}

/**
 * Parses the cleanup run a session can start without leaving it: the same
 * `gmail` command line the user would type at a shell prompt, minus the
 * `gmail`, so `gmail --limit 20`, `work --limit 20`, and `--limit 20` are
 * all the same request. Returns null for anything that is not one of these,
 * so an unrecognized command still falls through to the list's own handling
 * rather than being silently treated as a mailbox-mutating run.
 *
 * `--json` is deliberately not accepted: its whole contract is one machine
 * readable object on stdout, which is meaningless inside a session that
 * clears the screen around every redraw.
 */
export function parseCleanupCommand(cmd: string): CleanupCommand | null {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  let index = 0;
  if (tokens[index] === "gmail") index += 1;
  if (tokens[index] === "work") index += 1;
  // A bare "gmail"/"work" is the documented alias for a full run; a bare
  // flag list is the shorthand. Anything else is not this command.
  else if (index === 0 && !tokens[0]!.startsWith("--")) return null;

  const command: CleanupCommand = { dryRun: false, archive: false };
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--dry-run") {
      command.dryRun = true;
    } else if (token === "--archive") {
      command.archive = true;
    } else if (token === "--limit" || token.startsWith("--limit=")) {
      const raw = token.startsWith("--limit=") ? token.slice("--limit=".length) : tokens[++index];
      const limit = Number(raw);
      if (!Number.isInteger(limit) || limit <= 0) return null;
      command.limit = limit;
    } else {
      return null;
    }
    index += 1;
  }
  return command;
}

export function adjustPageSize(current: number, direction: "larger" | "smaller"): number {
  if (direction === "larger") {
    if (current >= 500) return current;
    return PAGE_SIZE_STEPS.find((size) => size > current) ?? Math.min(500, current * 2);
  }
  return [...PAGE_SIZE_STEPS].reverse().find((size) => size < current) ?? 1;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function filterMessages(
  messages: readonly CachedMessageRecord[],
  selectedTags: ReadonlySet<string>,
  search: string
): CachedMessageRecord[] {
  const needle = search.trim().toLocaleLowerCase();
  return messages.filter((message) => {
    const labelMatch = selectedTags.size === 0 || message.labelSnapshot.some((label) => selectedTags.has(label));
    const textMatch =
      !needle || `${message.subject ?? ""}\n${message.senderDisplay ?? ""}`.toLocaleLowerCase().includes(needle);
    return labelMatch && textMatch;
  });
}

function formatAge(iso: string): string {
  const elapsedMs = Math.max(0, Date.now() - Date.parse(iso));
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

async function loadLabelNames(client: GmailClient): Promise<Map<string, string>> {
  const names = systemLabelNames();
  try {
    for (const label of await listUserLabels(client)) names.set(label.id, label.name);
  } catch {
    // Raw IDs remain usable if this cosmetic lookup fails.
  }
  return names;
}

function systemLabelNames(): Map<string, string> {
  return new Map<string, string>([
    [GMAIL_LABELS.inbox, "Inbox"],
    [GMAIL_LABELS.spam, "Spam"],
    [GMAIL_LABELS.trash, "Trash"],
    [GMAIL_LABELS.unread, "Unread"],
    [GMAIL_LABELS.starred, "Starred"],
    [GMAIL_LABELS.important, "Important"],
    [GMAIL_LABELS.categoryPromotions, "Promotions"],
    [GMAIL_LABELS.categorySocial, "Social"],
    [GMAIL_LABELS.categoryUpdates, "Updates"],
    [GMAIL_LABELS.categoryForums, "Forums"]
  ]);
}

function collectDistinctTags(messages: readonly CachedMessageRecord[]): string[] {
  return [...new Set(messages.flatMap((message) => [...message.labelSnapshot]))].sort();
}

export function countViewFolders(messages: readonly CachedMessageRecord[]): Record<ViewFolderId, number> {
  const counts: Record<ViewFolderId, number> = { inbox: 0, archive: 0, trash: 0, spam: 0 };
  for (const message of messages) {
    const folder = folderForLabelSnapshot(message.labelSnapshot);
    if (folder) counts[folder] += 1;
  }
  return counts;
}

interface ListRenderState {
  folder: ViewFolderId;
  folderCounts: Readonly<Record<ViewFolderId, number>>;
  folderLoad: ReturnType<ProgressiveViewCache["status"]> | null;
  backgroundError: boolean;
  /** Another gmail process owns the account lock, so loading is paused. */
  waitingForAccountLock: boolean;
  page: number;
  totalPages: number;
  pageSize: number;
  total: number;
  selectedTags: ReadonlySet<string>;
  search: string;
  labelNames: ReadonlyMap<string, string>;
  notice: string | null;
  /** Row highlighted by ↑/↓, opened by Enter on an empty command. */
  selectedRow: number;
  /** Rows picked out by shift+↑/↓ or a row selector, which a bare row action acts on. */
  selection: ReadonlySet<number>;
}

function renderList(items: readonly CachedMessageRecord[], state: ListRenderState): void {
  clearScreen();
  console.log("");
  console.log(
    VIEW_FOLDERS.map((folder) => {
      const label = ` ${folder.label} ${state.folderCounts[folder.id]} `;
      return folder.id === state.folder ? pc.inverse(pc.bold(label)) : pc.dim(label);
    }).join(" ")
  );
  console.log("");
  const stillLoading = state.folderLoad !== null && !state.folderLoad.complete && !state.backgroundError;
  console.log(
    pc.bold(
      `Gmail ${viewFolderLabel(state.folder)} — ` +
        `${state.total}${stillLoading ? "+" : ""} message(s), page ${state.page + 1}/${state.totalPages} ` +
        `(page size ${state.pageSize})`
    )
  );
  if (state.waitingForAccountLock) {
    console.log(pc.yellow('Waiting for another gmail command to finish before loading more mail ("u" retries).'));
  } else if (stillLoading) {
    console.log(pc.dim("More mail is loading in the background."));
  }
  if (state.backgroundError || (state.folderLoad?.failed ?? 0) > 0) {
    console.log(pc.yellow("Some mail could not be loaded; it will be retried in a later refresh."));
  }
  const filters = [...state.selectedTags].map((tag) => state.labelNames.get(tag) ?? tag);
  if (filters.length > 0) console.log(pc.dim(`Labels: ${filters.join(", ")} (matching any)`));
  if (state.search) console.log(pc.dim(`Search: ${state.search}`));
  console.log("");
  if (items.length === 0) console.log(pc.dim("  (no matching messages)"));
  items.forEach((message, index) => {
    const unread = message.labelSnapshot.includes(GMAIL_LABELS.unread) ? pc.bold("●") : " ";
    const star = message.labelSnapshot.includes(GMAIL_LABELS.starred) ? pc.yellow("★") : " ";
    const date = message.internalDate ? new Date(Number(message.internalDate)).toLocaleDateString() : "";
    // Both fields are sender-controlled header text; never hand them to the
    // terminal raw (see core/terminal-text.ts).
    const subject = sanitizeTerminalLine(message.subject ?? "") || "(no subject)";
    const sender = sanitizeTerminalLine(message.senderDisplay ?? "") || "unknown";
    const line = `${String(index + 1).padStart(2)}. ${unread}${star} ${subject} — ${pc.dim(sender)} ${pc.dim(date)}`;
    // The cursor and the selection are different things and have to look
    // different: the cursor is inverted, every selected row is marked, and
    // the cursor is normally one of the selected rows.
    const marker = index === state.selectedRow ? ">" : state.selection.has(index) ? "*" : " ";
    const prefix = `${marker} `;
    if (index === state.selectedRow) console.log(pc.inverse(`${prefix}${line}`));
    else if (state.selection.has(index)) console.log(pc.cyan(`${prefix}${line}`));
    else console.log(`${prefix}${line}`);
  });
  console.log("");
  if (state.selection.size > 1) {
    console.log(pc.cyan(`${state.selection.size} rows selected — a row action with no rows applies to all of them.`));
  }
  // Notices quote subjects back to the user, so they are sanitized here
  // rather than at each of the dozen sites that builds one.
  if (state.notice) console.log(pc.yellow(sanitizeTerminalText(state.notice)));
  console.log(pc.dim(LIST_CONTROLS));
}

async function chooseTags(
  allTags: readonly string[],
  current: ReadonlySet<string>,
  labelNames: ReadonlyMap<string, string>
): Promise<Set<string>> {
  // Nothing to choose from (an empty folder) is not the same as choosing
  // nothing: clearing the filter here would silently discard a selection the
  // user set in a folder that does have mail.
  if (allTags.length === 0) return new Set(current);
  const selected = await p.multiselect({
    message: "Show messages carrying any selected label (select none for all mail)",
    options: allTags.map((tag) => ({ value: tag, label: labelNames.get(tag) ?? tag })),
    initialValues: [...current],
    required: false
  });
  return p.isCancel(selected) ? new Set(current) : new Set(selected);
}

async function openMessage(
  gmailClient: GmailClient,
  accountHash: string,
  userEmail: string,
  cached: CachedMessageRecord,
  ctx: ReturnType<typeof bootstrap>,
  getStyleProfile: (credentials: ResolvedOpenAiCredentials, forceRefresh?: boolean) => Promise<string | null>,
  canGoPrevious: boolean,
  canGoNext: boolean,
  runExclusive: ViewExclusiveRunner,
  onCacheProjected: (messageId: string) => void,
  /** Dispatches this action immediately on open (the "<n> r"/"<n> ;r" list shortcut) instead of waiting for a keypress first. Still goes through the normal confirm-before-send flow — this only skips the separate open-then-press-key navigation step. */
  initialAction?: "reply" | "ai_reply"
): Promise<OpenedMessage> {
  const messagesRepo = new MessagesRepository(ctx.db);
  let raw;
  let activeCached = cached;
  try {
    // Keep the live read and its possible mark-read/cache projection in one
    // bounded critical section so a concurrent work run cannot archive or
    // trash the message between our fetch and local cache update.
    raw = await runExclusive(async () => {
      let fetched = await fetchMessageFull(gmailClient, cached.gmailMessageId);
      let currentLabelIds = fetched.labelIds ?? [];
      if (currentLabelIds.includes(GMAIL_LABELS.unread)) {
        try {
          await modifyMessageLabels(
            gmailClient,
            cached.gmailMessageId,
            { addLabelIds: [], removeLabelIds: [GMAIL_LABELS.unread] },
            "gmail.messages.mark_read"
          );
          currentLabelIds = currentLabelIds.filter((label) => label !== GMAIL_LABELS.unread);
        } catch (error) {
          console.error(
            pc.yellow(`Message opened, but it could not be marked read: ${error instanceof Error ? error.message : String(error)}`)
          );
        }
      }
      // The live read is also authoritative about folder labels even when
      // the message was already read. This keeps an externally archived,
      // trashed, restored, or spammed row from lingering in the wrong tab.
      const projected = projectHydratedCacheMessage(
        accountHash,
        userEmail,
        ctx.clock.nowIso(),
        { id: cached.gmailMessageId, threadId: cached.gmailThreadId },
        { ...fetched, labelIds: currentLabelIds },
        messagesRepo.get(accountHash, cached.gmailMessageId) ?? cached,
        "view"
      );
      if (projected) {
        messagesRepo.upsert(projected);
        activeCached = projected;
        onCacheProjected(projected.gmailMessageId);
      } else {
        messagesRepo.delete(accountHash, cached.gmailMessageId);
      }
      fetched = { ...fetched, labelIds: currentLabelIds };
      return fetched;
    });
  } catch (error) {
    return {
      navigation: "back",
      notice: `Could not open this message: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const labelIds = raw.labelIds ?? [];
  const { plain, html } = extractBodyParts(raw.payload ?? undefined);
  const message = buildNormalizedMessage({
    gmailMessageId: cached.gmailMessageId,
    gmailThreadId: raw.threadId ?? cached.gmailThreadId,
    historyId: raw.historyId ?? "0",
    internalDate: raw.internalDate ?? cached.internalDate ?? "0",
    labelIds,
    snippet: raw.snippet ?? "",
    headers: headersFromMessage(raw),
    htmlBody: html,
    plainBody: plain,
    userEmail,
    threadHasUserSentMessage: false,
    // This normalization is for the screen, not for a model. The cache
    // projection above was built separately at the default cap, so the
    // persisted content hash is unaffected.
    maxBodyChars: VIEW_READ_BODY_CHARS
  });
  let edge: string | null = null;
  let pendingAction: ViewerAction | undefined = initialAction;
  for (;;) {
    // Redrawn from scratch each time round so arrow navigation replaces the
    // message on screen instead of stacking another copy underneath it.
    const links = renderMessage(message, labelIds);
    if (edge) console.log(pc.yellow(edge));
    console.log(
      pc.dim(
        "\n[esc] list   [←/p] previous   [→/n] next   [r] reply   [;][r] AI reply" +
          (activeCached.labelSnapshot.includes(GMAIL_LABELS.starred) ? "   [s] unstar" : "   [s] star") +
          (folderForLabelSnapshot(activeCached.labelSnapshot) !== "trash" ? "   [d] delete" : "") +
          (folderForLabelSnapshot(activeCached.labelSnapshot) !== "inbox" ? "   [i] move to Inbox" : "") +
          (links.length > 0 ? "   [l] show link URLs   [o] open link in browser" : "")
      )
    );
    edge = null;
    const action = pendingAction ?? await waitForViewerAction();
    pendingAction = undefined;
    if (action === "back") return { navigation: "back", notice: null };
    if (action === "previous") {
      if (canGoPrevious) return { navigation: "previous", notice: null };
      edge = "Already at the first message in this view.";
    }
    if (action === "next") {
      if (canGoNext) return { navigation: "next", notice: null };
      edge = "Already at the last message in this view.";
    }
    // Reply flows print their own prompts, drafts, and previews, so they
    // deliberately run below the message rather than over a cleared screen;
    // the next loop pass redraws once the exchange is finished.
    if (action === "reply" || action === "ai_reply") {
      if (action === "reply") await handleManualReply(gmailClient, accountHash, message, runExclusive);
      else await handleAiReply(gmailClient, accountHash, ctx, message, getStyleProfile, runExclusive);
      // Hold the send confirmation on screen; the redraw above would wipe it.
      console.log(pc.dim("\nPress any key to return to the message."));
      await waitForKeypress();
    }
    if (action === "links") {
      console.log("");
      if (links.length === 0) {
        console.log(pc.dim("No links in this message."));
      } else {
        console.log(pc.bold("Links:"));
        for (const link of links) console.log(`  ${link.label} ${link.url}`);
      }
      console.log(pc.dim("\nPress any key to return to the message."));
      await waitForKeypress();
    }
    if (action === "star") {
      const starred = !activeCached.labelSnapshot.includes(GMAIL_LABELS.starred);
      const outcome = await runExclusive(() =>
        setCachedStar(gmailClient, messagesRepo, activeCached, starred, ctx.clock.nowIso())
      );
      if (outcome.ok) {
        activeCached = outcome.record;
        onCacheProjected(outcome.record.gmailMessageId);
        edge = starred ? "Starred." : "Unstarred.";
      } else {
        edge = outcome.message;
      }
      continue;
    }
    if (action === "delete") {
      if (folderForLabelSnapshot(activeCached.labelSnapshot) === "trash") {
        edge = "Already in Trash; permanent deletion is never supported.";
        continue;
      }
      const outcome = await confirmAndTrash(
        gmailClient,
        messagesRepo,
        activeCached,
        runExclusive,
        ctx.clock.nowIso()
      );
      // Only an actual delete leaves the message, so only an actual delete
      // has a confirmation worth holding on screen. Declining used to ask
      // the user to "press any key to return to the list" and then put them
      // back on the message they never left; a failure was worse, since the
      // reason scrolled away with it. Both now redraw straight away, with
      // the failure carried into the redraw as an edge notice.
      if (outcome.status === "declined") continue;
      if (outcome.status === "failed") {
        edge = outcome.message;
        continue;
      }
      console.log(pc.dim("\nPress any key to return to the list."));
      await waitForKeypress();
      onCacheProjected(outcome.record.gmailMessageId);
      return { navigation: "back", notice: "Moved to Trash. \";u\" undoes it.", trashedRecord: outcome.record };
    }
    if (action === "move_to_inbox") {
      const outcome = await runExclusive(() =>
        moveCachedToInbox(gmailClient, messagesRepo, activeCached, ctx.clock.nowIso())
      );
      if (outcome.record) {
        activeCached = outcome.record;
        onCacheProjected(outcome.record.gmailMessageId);
      }
      if (outcome.ok) {
        return { navigation: "back", notice: `Moved "${outcome.record.subject || "(no subject)"}" to Inbox.` };
      }
      edge = outcome.message;
    }
    if (action === "open_link") {
      console.log("");
      if (links.length === 0) {
        console.log(pc.dim("No links in this message."));
      } else {
        const choice = await p.text({
          message: `Open which link in your browser? (1-${links.length})`,
          ...(links.length === 1 ? { placeholder: "1" } : {})
        });
        if (!p.isCancel(choice)) {
          const raw = choice.trim() || (links.length === 1 ? "1" : "");
          const index = Number(raw);
          const link = Number.isInteger(index) ? links[index - 1] : undefined;
          if (link) {
            openUrlInBrowser(link.url);
            console.log(pc.green(`Opening ${link.label} in your system browser.`));
          } else {
            console.log(pc.red("No such link number."));
          }
        }
      }
      console.log(pc.dim("\nPress any key to return to the message."));
      await waitForKeypress();
    }
  }
}

/**
 * Trash only — this app never calls Gmail's permanent-delete endpoints
 * (see CLAUDE.md's "Never call Gmail's permanent-delete endpoints"), so
 * "delete" here always means the same reversible Trash move `gmail work`
 * uses, recoverable from Gmail's own Trash folder. Defaults to "yes" on
 * confirm (unlike every send confirmation in this app, which defaults to
 * "no") because this action is reversible two ways: Gmail's own Trash and,
 * within this session, ";u" (see `runView`'s `lastTrashed`) — the returned
 * record is exactly what a caller needs to offer that quick undo. The local
 * row moves to the Trash projection immediately, so it disappears from its
 * old folder and appears in the Trash tab without another Gmail sync.
 */
export type ConfirmTrashOutcome =
  | { status: "trashed"; record: CachedMessageRecord }
  | { status: "declined" }
  | { status: "failed"; message: string };

/** `"Subject"`, sanitized — sender-controlled header text quoted back into a notice. */
export function quoteSubject(cached: CachedMessageRecord): string {
  return `"${sanitizeTerminalLine(cached.subject ?? "") || "(no subject)"}"`;
}

/**
 * The one Trash question, asked the same way for one message and for a
 * selection of them. Defaults to "yes" — unlike every send confirmation in
 * this app, which defaults to "no" — because Trash is reversible twice
 * over: from Gmail itself, and from ";u" within this session.
 */
async function confirmTrash(targets: readonly CachedMessageRecord[]): Promise<boolean> {
  console.log("");
  const confirmed = await p.confirm({
    message:
      targets.length === 1
        ? `Move ${quoteSubject(targets[0]!)} to Trash?`
        : `Move ${targets.length} messages to Trash?`,
    initialValue: true
  });
  return !p.isCancel(confirmed) && confirmed;
}

export interface BulkOutcome {
  /** The records that really changed, in the order they were applied. */
  done: CachedMessageRecord[];
  failures: string[];
}

/**
 * Runs a per-message operation across a selection, keeping going after an
 * isolated failure and reporting both sides — the same "continue
 * independent actions after an isolated failure" rule the rest of this app
 * follows. Deliberately sequential: these are Gmail writes made on the
 * user's behalf while they wait, and a selection is a handful of rows, not
 * a mailbox sweep.
 */
export async function applyToTargets(
  targets: readonly CachedMessageRecord[],
  apply: (target: CachedMessageRecord) => Promise<{ ok: true; record: CachedMessageRecord } | { ok: false; message: string }>
): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { done: [], failures: [] };
  for (const target of targets) {
    const result = await apply(target);
    if (result.ok) outcome.done.push(result.record);
    else outcome.failures.push(result.message);
  }
  return outcome;
}

/**
 * One notice describing what a bulk action actually did. A single message
 * is named; several are counted, because a notice listing five subjects is
 * unreadable on one line. Failures are always mentioned: a row action that
 * silently did nothing to two of five messages is exactly the kind of
 * quiet partial success this app does not allow.
 */
export function summarizeBulk(
  outcome: BulkOutcome,
  one: (record: CachedMessageRecord) => string,
  many: (count: number) => string,
  extra?: string
): string | null {
  const parts: string[] = [];
  if (outcome.done.length === 1) parts.push(one(outcome.done[0]!));
  else if (outcome.done.length > 1) parts.push(many(outcome.done.length));
  if (outcome.failures.length === 1) parts.push(outcome.failures[0]!);
  else if (outcome.failures.length > 1) {
    parts.push(`${outcome.failures.length} failed; first: ${outcome.failures[0]}`);
  }
  if (extra) parts.push(extra);
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * Adds or removes Gmail's `STARRED` label — the "s" row action and the read
 * view's "s". Only `STARRED`: `IMPORTANT` is what `gmail work`'s importance
 * policy adds alongside it, and a user starring a row in a list is asking
 * for a star, not for a classification. Already in the wanted state is a
 * success with no Gmail call at all, so "s" over a mixed selection stars
 * only the rows that need it.
 */
export async function setCachedStar(
  gmailClient: GmailClient,
  messagesRepo: MessagesRepository,
  cached: CachedMessageRecord,
  starred: boolean,
  nowIso = cached.processedAt
): Promise<{ ok: true; record: CachedMessageRecord } | { ok: false; message: string }> {
  if (cached.labelSnapshot.includes(GMAIL_LABELS.starred) === starred) return { ok: true, record: cached };
  try {
    await modifyMessageLabels(
      gmailClient,
      cached.gmailMessageId,
      starred
        ? { addLabelIds: [GMAIL_LABELS.starred], removeLabelIds: [] }
        : { addLabelIds: [], removeLabelIds: [GMAIL_LABELS.starred] },
      starred ? "gmail.messages.star" : "gmail.messages.unstar"
    );
    const labels = starred
      ? [...cached.labelSnapshot, GMAIL_LABELS.starred]
      : cached.labelSnapshot.filter((label) => label !== GMAIL_LABELS.starred);
    // A changed label snapshot is a changed policy input, so the cached
    // assessment goes with it — exactly as it does for a Trash or Inbox
    // move, and as the next cache hydration would do anyway.
    const record = invalidateCachedAssessment(cached, labels, nowIso);
    messagesRepo.upsert(record);
    return { ok: true, record };
  } catch (error) {
    return {
      ok: false,
      message: `Could not ${starred ? "star" : "unstar"}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function confirmAndTrash(
  gmailClient: GmailClient,
  messagesRepo: MessagesRepository,
  cached: CachedMessageRecord,
  runExclusive: ViewExclusiveRunner,
  nowIso: string
): Promise<ConfirmTrashOutcome> {
  if (!(await confirmTrash([cached]))) {
    console.log(pc.dim("Not deleted."));
    return { status: "declined" };
  }
  const outcome = await runExclusive(() => trashCached(gmailClient, messagesRepo, cached, nowIso));
  // The failure text is returned rather than printed so each caller can put
  // it where that caller's screen will still show it — a read view that
  // redraws immediately needs it as a carried notice, not as a line about to
  // be erased.
  if (!outcome.ok) return { status: "failed", message: outcome.message };
  console.log(pc.green('Moved to Trash. Type ";u" to undo.'));
  return { status: "trashed", record: outcome.record };
}

/**
 * The Trash move itself, with no prompting and no output of its own.
 *
 * Separated from `confirmAndTrash` so the unprompted "dd" path and the
 * confirmed "d" path cannot diverge on what deleting actually does: the
 * same reversible `messages.trash`, the same immediate local folder move,
 * and the same returned record that makes ";u" able to undo it.
 * Only the question in front of it differs. Returns null on failure after
 * reporting it, so a caller never records an undo for a delete that did
 * not happen.
 */
export type TrashOutcome =
  | { ok: true; record: CachedMessageRecord }
  | { ok: false; message: string };

export async function trashCached(
  gmailClient: GmailClient,
  messagesRepo: MessagesRepository,
  cached: CachedMessageRecord,
  nowIso = cached.processedAt
): Promise<TrashOutcome> {
  if (folderForLabelSnapshot(cached.labelSnapshot) === "trash") {
    return { ok: false, message: "Already in Trash; permanent deletion is never supported." };
  }
  try {
    await trashMessage(gmailClient, cached.gmailMessageId);
    const labels = cached.labelSnapshot.filter(
      (label) => label !== GMAIL_LABELS.inbox && label !== GMAIL_LABELS.spam && label !== GMAIL_LABELS.trash
    );
    messagesRepo.upsert(invalidateCachedAssessment(cached, [...labels, GMAIL_LABELS.trash], nowIso));
    return { ok: true, record: cached };
  } catch (error) {
    // Returned rather than printed: "dd" deliberately has no "press any key"
    // pause, so anything written here would be erased by the next redraw and
    // the message would appear to have been deleted when it was not.
    return { ok: false, message: `Could not move to Trash: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type MoveToInboxOutcome =
  | { ok: true; record: CachedMessageRecord }
  | { ok: false; message: string; record?: CachedMessageRecord };

/**
 * The single `i` action used by Archive, Trash, and Spam. Trash must first
 * use Gmail's untrash endpoint; Spam is removed explicitly; Archive simply
 * regains INBOX. The cached assessment is invalidated because restoring a
 * message to Inbox changes cleanup policy inputs.
 */
export async function moveCachedToInbox(
  gmailClient: GmailClient,
  messagesRepo: MessagesRepository,
  cached: CachedMessageRecord,
  nowIso = cached.processedAt
): Promise<MoveToInboxOutcome> {
  const folder = folderForLabelSnapshot(cached.labelSnapshot);
  if (folder === "inbox") return { ok: false, message: "This message is already in Inbox." };
  if (folder === null) return { ok: false, message: "This message is not in a browsable Gmail folder." };

  try {
    if (folder === "trash") {
      // Never pass the cached Trash snapshot here: doing so would re-add the
      // TRASH label immediately after Gmail removed it.
      await untrashMessage(gmailClient, cached.gmailMessageId);
      try {
        await modifyMessageLabels(
          gmailClient,
          cached.gmailMessageId,
          {
            addLabelIds: [GMAIL_LABELS.inbox],
            removeLabelIds: cached.labelSnapshot.includes(GMAIL_LABELS.spam) ? [GMAIL_LABELS.spam] : []
          },
          "gmail.messages.move_from_trash_to_inbox"
        );
      } catch (error) {
        // `untrash` and `modify` are two Gmail operations. If the first
        // succeeds but the Inbox add fails, keeping a TRASH projection would
        // be observably wrong. Preserve the successful partial remote state;
        // the user can press i again from Archive/Spam to finish the move.
        const partialRecord = invalidateCachedAssessment(
          cached,
          cached.labelSnapshot.filter((label) => label !== GMAIL_LABELS.trash),
          nowIso
        );
        try {
          messagesRepo.upsert(partialRecord);
        } catch {
          // Gmail is authoritative; a later refresh will reconcile a local
          // write failure without pretending the Inbox step succeeded.
        }
        return {
          ok: false,
          message:
            "Restored from Trash, but could not move to Inbox: " +
            (error instanceof Error ? error.message : String(error)),
          record: partialRecord
        };
      }
    } else {
      await modifyMessageLabels(
        gmailClient,
        cached.gmailMessageId,
        {
          addLabelIds: [GMAIL_LABELS.inbox],
          removeLabelIds: folder === "spam" ? [GMAIL_LABELS.spam] : []
        },
        folder === "spam" ? "gmail.messages.not_spam" : "gmail.messages.unarchive"
      );
    }

    const labels = cached.labelSnapshot.filter(
      (label) => label !== GMAIL_LABELS.trash && label !== GMAIL_LABELS.spam && label !== GMAIL_LABELS.inbox
    );
    const record = invalidateCachedAssessment(cached, [...labels, GMAIL_LABELS.inbox], nowIso);
    messagesRepo.upsert(record);
    return { ok: true, record };
  } catch (error) {
    return {
      ok: false,
      message: `Could not move to Inbox: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function invalidateCachedAssessment(
  cached: CachedMessageRecord,
  labelSnapshot: readonly string[],
  processedAt: string
): CachedMessageRecord {
  return {
    ...cached,
    labelSnapshot: [...new Set(labelSnapshot)],
    classifierVersion: null,
    promptVersion: null,
    schemaVersion: null,
    policyVersion: null,
    assessmentKind: null,
    assessmentConfidence: null,
    importanceScore: null,
    importanceConfidence: null,
    reasonCodes: null,
    category: null,
    assessmentHadEvent: null,
    processedAt
  };
}

export interface DisplayLink {
  label: string;
  url: string;
}

/**
 * Wraps `label` as an OSC 8 terminal hyperlink pointing at `url` — most
 * modern terminals (iTerm2, Terminal.app, Windows Terminal, kitty, wezterm,
 * ...) render this as clickable text that opens the URL in the system
 * browser, entirely client-side; this app never opens anything itself. A
 * terminal without OSC 8 support just shows `label` with the surrounding
 * escape bytes ignored — never garbage — since OSC 8 degrades that way by
 * design. Skipped when stdout isn't a TTY so redirected output stays plain.
 */
export function terminalHyperlink(label: string, url: string): string {
  if (!process.stdout.isTTY) return label;
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

/**
 * Replaces every URL in `text` with a short, numbered, clickable label
 * (`[1]`, `[2]`, ...) instead of the full address — the same URL reused
 * later in the message reuses its earlier number rather than getting a new
 * one. Pairs with `terminalHyperlink`: the label is still a real working
 * link via OSC 8, so shortening is purely cosmetic, never a loss of
 * function. Returns the link table so the read view can offer "show link
 * URL" for a terminal that doesn't render OSC 8, or for the merely
 * cautious.
 */
export function shortenLinksForDisplay(text: string): { text: string; links: DisplayLink[] } {
  const links: DisplayLink[] = [];
  const indexByUrl = new Map<string, number>();
  const rewritten = text.replace(URL_IN_BODY, (match) => {
    // What the address ends at is a real correctness question, not a
    // cosmetic one: the captured string is what the OSC 8 link and the "o"
    // command hand to the browser, so a swallowed delimiter is a link that
    // does not open. A body that writes a URL as "<https://discord.gg/x>*"
    // — angle brackets from plain-text mail or a decoded &lt;/&gt;, then
    // stray emphasis — used to produce "https://discord.gg/x>*".
    const url = trimUrlPunctuation(match);
    if (url.length === 0) return match;
    const trailing = match.slice(url.length);
    let index = indexByUrl.get(url);
    if (index === undefined) {
      index = links.length + 1;
      indexByUrl.set(url, index);
      links.push({ label: `[${index}]`, url });
    }
    // The punctuation was never part of the address, so it stays in the
    // sentence rather than disappearing with the link it followed.
    return terminalHyperlink(pc.underline(pc.cyan(`[${index}]`)), url) + trailing;
  });
  return { text: rewritten, links };
}

/**
 * A URL inside a message body. Angle brackets, quotes and backticks are
 * excluded outright: a body may well wrap an address in them (plain-text
 * mail routinely writes `<https://example.com/x>`, and HTML mail gets there
 * via `&lt;`/`&gt;`), and they can never appear inside one. `)` is excluded
 * too, because `gmail/normalize.ts` renders an HTML anchor as
 * `link text (https://...)` and the closing parenthesis it adds is not part
 * of the address either.
 */
const URL_IN_BODY = /https?:\/\/[^\s<>"'`]+/g;

/**
 * Drops trailing characters that are sentence punctuation around an address
 * rather than part of it. Deliberately conservative: only characters that
 * are essentially never meaningful at the end of a real URL.
 *
 * A closing parenthesis is decided by balance rather than by a blanket
 * rule, because both readings are common and both matter: the `)` of
 * `gmail/normalize.ts`'s `link text (https://...)` rendering is not part of
 * the address, while the one in
 * `https://en.wikipedia.org/wiki/Fable_(disambiguation)` is — and dropping
 * it there produces a link that quietly goes somewhere else.
 */
export function trimUrlPunctuation(url: string): string {
  const occurrences = (text: string, character: string): number =>
    text.split(character).length - 1;
  let trimmed = url;
  for (;;) {
    const stripped = trimmed.replace(/[.,;:!?*_~\]}>]+$/, "");
    const unbalanced =
      stripped.endsWith(")") && occurrences(stripped, ")") > occurrences(stripped, "(");
    const next = unbalanced ? stripped.slice(0, -1) : stripped;
    if (next === trimmed) return trimmed;
    trimmed = next;
  }
}

/**
 * Opens `url` in the user's default system browser via the OS's own
 * "open"/"start"/"xdg-open" launcher — this app never fetches the URL
 * itself; the browser does, exactly as if the user had clicked the OSC 8
 * hyperlink (`terminalHyperlink`) themselves. Restricted to http(s) so a
 * non-web scheme extracted from a message body can never reach a shell
 * launcher — defense-in-depth alongside `shortenLinksForDisplay` only ever
 * capturing http(s) URLs from the body in the first place.
 */
/** Thin wrapper so the view keeps its own wording for a failed launch. */
export function openUrlInBrowser(url: string): void {
  openUrlInSystemBrowser(url, (target) => {
    console.error(pc.yellow(`Could not launch a browser automatically. Open this URL manually: ${target}`));
  });
}

function renderMessage(message: NormalizedMessage, labelIds: readonly string[]): readonly DisplayLink[] {
  clearScreen();
  console.log("");
  console.log(pc.bold(sanitizeTerminalLine(message.subject) || "(no subject)"));
  console.log(`From: ${sanitizeTerminalLine(message.from.displayName ?? message.from.address ?? "") || "unknown"}`);
  if (message.to.length > 0) {
    console.log(
      `To: ${message.to.map((address) => sanitizeTerminalLine(address.displayName ?? address.address ?? "") || "unknown").join(", ")}`
    );
  }
  if (message.dateHeader) console.log(`Date: ${sanitizeTerminalLine(message.dateHeader)}`);
  console.log(pc.dim(`Read: ${isRead(labelIds) ? "yes" : "no"}`));
  console.log("");
  // The body is the most exposed surface of all: an escape sequence here
  // could forge this view's own numbered OSC 8 link labels.
  const content = sanitizeTerminalText(message.bodyText ?? message.snippet);
  if (content.length === 0) {
    console.log(pc.dim("(no content)"));
    return [];
  }
  const { text, links } = shortenLinksForDisplay(content);
  console.log(text);
  if (message.bodyTruncated) {
    // Silently stopping mid-message is the one thing a mail reader must not
    // do: the reader cannot tell a cut-off message from a short one.
    console.log("");
    console.log(pc.yellow(`(message truncated at ${VIEW_READ_BODY_CHARS.toLocaleString()} characters)`));
  }
  return links;
}

type ViewerAction =
  | "back"
  | "previous"
  | "next"
  | "reply"
  | "ai_reply"
  | "delete"
  | "move_to_inbox"
  | "star"
  | "links"
  | "open_link";

interface OpenedMessage {
  navigation: "back" | "previous" | "next";
  /** Surfaced by the list after its own redraw, which would otherwise erase it. */
  notice: string | null;
  /** Set when this message was just trashed, so the caller can offer ";u" to undo it. */
  trashedRecord?: CachedMessageRecord;
}

async function waitForViewerAction(): Promise<ViewerAction> {
  let lastName: string | null = null;
  let lastAt = 0;
  for (;;) {
    const key = await waitForKeypress();
    if (key.name === "escape") return "back";
    if (key.name === "left" || key.name === "p") return "previous";
    if (key.name === "right" || key.name === "n") return "next";
    if (key.name === "r" && lastName === ";" && Date.now() - lastAt < 1000) return "ai_reply";
    if (key.name === "r") return "reply";
    if (key.name === "d") return "delete";
    if (key.name === "s") return "star";
    if (key.name === "i") return "move_to_inbox";
    if (key.name === "l") return "links";
    if (key.name === "o") return "open_link";
    lastName = key.name;
    lastAt = Date.now();
  }
}

async function handleManualReply(
  gmailClient: GmailClient,
  accountHash: string,
  message: NormalizedMessage,
  runExclusive: ViewExclusiveRunner
): Promise<void> {
  const target = buildReplyTarget(message);
  if (!target) {
    console.log(pc.red("This message has no usable address to reply to."));
    return;
  }
  const body = await promptBody(`Reply to ${target.to}`);
  if (!body) {
    console.log(pc.dim("Cancelled."));
    return;
  }
  await confirmAndSend(gmailClient, accountHash, target, body, runExclusive);
}

async function handleAiReply(
  gmailClient: GmailClient,
  accountHash: string,
  ctx: ReturnType<typeof bootstrap>,
  message: NormalizedMessage,
  getStyleProfile: (credentials: ResolvedOpenAiCredentials, forceRefresh?: boolean) => Promise<string | null>,
  runExclusive: ViewExclusiveRunner
): Promise<void> {
  const target = buildReplyTarget(message);
  if (!target) {
    console.log(pc.red("This message has no usable address to reply to."));
    return;
  }
  const credentials = await resolveOpenAiCredentials(
    { accountHash, credentialStore: ctx.credentialStore, config: ctx.config },
    "compose"
  );
  if (!credentials) {
    console.log(pc.yellow("AI is not ready — check `gmail setup`, or use r for a manual reply instead."));
    return;
  }
  const guidance = await p.text({ message: "Optional guidance for the reply", placeholder: "Press Enter to let AI decide" });
  if (p.isCancel(guidance)) return;
  const spinner = p.spinner();
  spinner.start("Drafting");
  const styleProfile = await runExclusive(() => getStyleProfile(credentials));
  const draft = await draftReply(message, credentials, { styleProfile, guidance });
  spinner.stop(draft ? "Draft ready." : "Could not draft a reply.");
  if (!draft) return;
  const edited = await reviewAiDraft(draft);
  if (!edited) {
    console.log(pc.dim("Discarded."));
    return;
  }
  await confirmAndSend(gmailClient, accountHash, target, edited, runExclusive);
}
