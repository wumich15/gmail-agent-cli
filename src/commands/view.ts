import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { openUrlInBrowser as openUrlInSystemBrowser } from "../core/open-browser.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { latestCacheRefreshAt } from "./work.js";
import { MessagesRepository, type CachedMessageRecord } from "../state/repositories/messages.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { fetchMessageFull, headersFromMessage } from "../gmail/scanner.js";
import { buildNormalizedMessage, extractBodyParts } from "../gmail/normalize.js";
import { GMAIL_LABELS, isRead } from "../gmail/labels.js";
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

function viewFolderLabel(folder: ViewFolderId): string {
  return VIEW_FOLDERS.find((candidate) => candidate.id === folder)!.label;
}

const LIST_CONTROLS =
  "↑/↓ select · enter open · type email number to open · d delete highlighted row · dd delete it without asking · " +
  "i move highlighted row to Inbox · <n> r/;r/d/i reply/AI-reply/delete/Inbox · " +
  "←/→ folders · n/p page · [ ] history · esc home · +/- size · l <n> · f filter · s Inbox search · c/a compose · " +
  ";s refresh writing style · ;u undo last delete · u refresh · q quit";

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
  if (options.previous) {
    console.error(pc.dim("Using the previous Gmail cache without refreshing it."));
  } else {
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
  /** Highlighted row within the current page — moved by ↑/↓, opened by Enter on an empty command. */
  let selectedRow = 0;
  /** The most recently trashed message from this session, for the ";u" quick-undo command. */
  let lastTrashed: CachedMessageRecord | null = null;
  const backStack: ListViewSnapshot[] = [];
  const forwardStack: ListViewSnapshot[] = [];
  const snapshotView = (): ListViewSnapshot => ({
    folder: activeFolder,
    page,
    pageSize,
    selectedTags: new Set(selectedTags),
    search
  });
  const restoreView = (snapshot: ListViewSnapshot): void => {
    activeFolder = snapshot.folder;
    page = snapshot.page;
    pageSize = snapshot.pageSize;
    selectedTags = new Set(snapshot.selectedTags);
    search = snapshot.search;
  };
  const rememberView = (): void => {
    backStack.push(snapshotView());
    if (backStack.length > 50) backStack.shift();
    forwardStack.length = 0;
  };
  // Saved once to SQLite (see gmail/writing-style.ts) instead of being
  // re-derived from a live Sent-mail fetch on every single AI draft/reply —
  // a settings-table read is essentially free, so no additional in-memory
  // caching is needed here; ";s" forces a real recomputation on demand.
  const getStyleProfile = (credentials: ResolvedOpenAiCredentials, forceRefresh = false): Promise<string | null> =>
    getWritingStyleProfile(
      {
        db: ctx.db,
        accountHash: account.accountHash,
        gmailClient,
        userEmail: account.emailDisplay ?? "",
        credentials,
        nowIso: () => ctx.clock.nowIso()
      },
      forceRefresh
    );

  let notice: string | null = null;
  try {
    for (;;) {
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
        if (opened.trashedRecord) lastTrashed = opened.trashedRecord;
        if (opened.navigation === "previous") messageIndex -= 1;
        else if (opened.navigation === "next") messageIndex += 1;
        else break;
      }
      all = messagesRepo.listForAccount(account.accountHash);
      return { notice: openedNotice };
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
      selectedRow
    });
    notice = null;
    const input = await readCommandLine("> ", ["left", "right", "up", "down"]);
    if (input.kind === "cancel") {
      // Esc always goes "home" (default Inbox filter, no search, first
      // page) instead of quitting — quitting is q/Ctrl-C only. Useful
      // after a search or a deep filter/page-history dive.
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
      if (input.name === "up" || input.name === "down") {
        if (pageItems.length > 0) {
          selectedRow =
            input.name === "up"
              ? (selectedRow - 1 + pageItems.length) % pageItems.length
              : (selectedRow + 1) % pageItems.length;
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
      if (page > 0) rememberView();
      page = Math.max(page - 1, 0);
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
      const nextSize = adjustPageSize(pageSize, cmd === "+" ? "larger" : "smaller");
      if (nextSize !== pageSize) {
        const firstVisibleIndex = page * pageSize;
        rememberView();
        pageSize = nextSize;
        page = Math.floor(firstVisibleIndex / pageSize);
        if (progressiveCache.current) {
          await progressiveCache.current.ensureFolder(activeFolder, (page + 1) * pageSize, {
            timeoutMs: VIEW_NAVIGATION_WAIT_MS
          });
        }
      }
      continue;
    }
    const limitMatch = /^l\s+(\d+)$/.exec(cmd);
    if (limitMatch) {
      const nextSize = Math.max(1, Number(limitMatch[1]));
      if (nextSize !== pageSize) {
        const firstVisibleIndex = page * pageSize;
        rememberView();
        pageSize = nextSize;
        page = Math.floor(firstVisibleIndex / pageSize);
        if (progressiveCache.current) {
          await progressiveCache.current.ensureFolder(activeFolder, (page + 1) * pageSize, {
            timeoutMs: VIEW_NAVIGATION_WAIT_MS
          });
        }
      }
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
    if (cmd === "s") {
      if (!viewFolderSupportsSearch(activeFolder)) {
        notice = "Search is currently available only in Inbox.";
        continue;
      }
      if (search) {
        rememberView();
        search = "";
        page = 0;
      }
      continue;
    }
    const searchMatch = /^s\s+(.+)$/.exec(cmd);
    if (searchMatch) {
      if (!viewFolderSupportsSearch(activeFolder)) {
        notice = "Search is currently available only in Inbox.";
        continue;
      }
      const nextSearch = searchMatch[1]!.trim();
      if (nextSearch !== search) {
        rememberView();
        search = nextSearch;
        page = 0;
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
      const spinner = p.spinner();
      spinner.start("Refreshing your writing style from recent Sent mail");
      const profile = await operations.runExclusive(() => getStyleProfile(credentials, true));
      spinner.stop(profile ? "Writing style saved — future replies/drafts will reuse it." : "Could not derive a writing style from Sent mail.");
      console.log(pc.dim("\nPress any key to return to the list."));
      await waitForKeypress();
      continue;
    }
    if (cmd === ";u") {
      if (!lastTrashed) {
        notice = "Nothing to undo.";
        continue;
      }
      const toRestore = lastTrashed;
      try {
        await operations.runExclusive(async () => {
          await untrashMessage(gmailClient, toRestore.gmailMessageId, toRestore.labelSnapshot);
          // Refresh the projection timestamp so a concurrent progressive
          // snapshot that began before this undo cannot prune the restored
          // row after its folder cursors have already passed it.
          messagesRepo.upsert({ ...toRestore, processedAt: ctx.clock.nowIso() });
        });
        retainInProgressiveSnapshot(toRestore.gmailMessageId);
        all = messagesRepo.listForAccount(account.accountHash);
        lastTrashed = null;
        notice = `Restored "${toRestore.subject || "(no subject)"}".`;
      } catch (error) {
        notice = `Could not undo: ${error instanceof Error ? error.message : String(error)}`;
      }
      continue;
    }
    if (cmd === "i") {
      if (pageItems.length > 0) {
        const target = pageItems[selectedRow]!;
        const outcome = await operations.runExclusive(() =>
          moveCachedToInbox(gmailClient, messagesRepo, target, ctx.clock.nowIso())
        );
        if (outcome.record) retainInProgressiveSnapshot(outcome.record.gmailMessageId);
        notice = outcome.ok
          ? `Moved "${outcome.record.subject || "(no subject)"}" to Inbox.`
          : outcome.message;
      }
      continue;
    }
    if (cmd === "dd") {
      // "dd" — the same delete as "d" on the highlighted row, with the
      // confirmation skipped, for clearing a run of junk quickly. Deleting
      // still means Gmail's Trash, never a permanent delete, and is still
      // undoable both from Gmail and, for the last one this session, with
      // ";u" — which is precisely what makes skipping the question
      // acceptable here when skipping a *send* confirmation never is.
      //
      // No "press any key" pause either: the point is speed, so the result
      // is carried as a notice and printed by the next render instead. The
      // cursor stays on the same row number, which after the list shifts up
      // is the following message — so repeating "dd" walks down the list.
      if (pageItems.length > 0) {
        const target = pageItems[selectedRow]!;
        const outcome = await operations.runExclusive(() =>
          trashCached(gmailClient, messagesRepo, target, ctx.clock.nowIso())
        );
        if (outcome.ok) {
          retainInProgressiveSnapshot(outcome.record.gmailMessageId);
          lastTrashed = outcome.record;
          notice = `Moved "${outcome.record.subject || "(no subject)"}" to Trash. ";u" undoes it.`;
          all = messagesRepo.listForAccount(account.accountHash);
        } else {
          notice = outcome.message;
        }
      }
      continue;
    }
    if (cmd === "d") {
      // Bare "d" — the arrow-key highlight's counterpart to "<n> d": deletes
      // whichever row is currently highlighted, without needing to type its
      // number first. Same reversible Trash move, same defaulted-to-yes
      // confirmation, same instant local folder move and ";u" undo.
      if (pageItems.length > 0) {
        if (activeFolder === "trash") {
          notice = "Already in Trash; permanent deletion is never supported.";
          continue;
        }
        const trashed = await handleQuickDelete(
          gmailClient,
          messagesRepo,
          pageItems[selectedRow]!,
          operations.runExclusive,
          ctx.clock.nowIso()
        );
        if (trashed) {
          retainInProgressiveSnapshot(trashed.gmailMessageId);
          lastTrashed = trashed;
        }
        console.log(pc.dim("\nPress any key to return to the list."));
        await waitForKeypress();
        all = messagesRepo.listForAccount(account.accountHash);
      }
      continue;
    }
    // "<n> r" / "<n> ;r" / "<n> d" / "<n> i" — act directly from the
    // list without the separate open-then-press-key steps. Reply/AI-reply
    // still open the message first (real content is needed to draft
    // against) and still show the full, unedited confirmation screen
    // before anything sends — this is a navigation shortcut only, never a
    // way to skip that confirmation (see CLAUDE.md's "Interactive reply").
    const quickAction = parseQuickActionCommand(cmd);
    if (quickAction) {
      const { index, action } = quickAction;
      if (index >= 1 && index <= pageItems.length) {
        const messageIndex = page * pageSize + index - 1;
        const target = visible[messageIndex]!;
        if (action === "delete") {
          if (folderForLabelSnapshot(target.labelSnapshot) === "trash") {
            notice = "Already in Trash; permanent deletion is never supported.";
            continue;
          }
          const trashed = await handleQuickDelete(
            gmailClient,
            messagesRepo,
            target,
            operations.runExclusive,
            ctx.clock.nowIso()
          );
          if (trashed) {
            retainInProgressiveSnapshot(trashed.gmailMessageId);
            lastTrashed = trashed;
          }
          console.log(pc.dim("\nPress any key to return to the list."));
          await waitForKeypress();
          all = messagesRepo.listForAccount(account.accountHash);
        } else if (action === "move_to_inbox") {
          const outcome = await operations.runExclusive(() =>
            moveCachedToInbox(gmailClient, messagesRepo, target, ctx.clock.nowIso())
          );
          if (outcome.record) retainInProgressiveSnapshot(outcome.record.gmailMessageId);
          notice = outcome.ok
            ? `Moved "${outcome.record.subject || "(no subject)"}" to Inbox.`
            : outcome.message;
        } else {
          const opened = await openMessage(
            gmailClient,
            account.accountHash,
            account.emailDisplay ?? "",
            target,
            ctx,
            getStyleProfile,
            false,
            false,
            operations.runExclusive,
            retainInProgressiveSnapshot,
            action
          );
          notice = opened.notice;
          if (opened.trashedRecord) lastTrashed = opened.trashedRecord;
          all = messagesRepo.listForAccount(account.accountHash);
        }
        continue;
      }
    }
    const index = Number(cmd);
    if (Number.isInteger(index) && index >= 1 && index <= pageItems.length) {
      const opened = await openSelectedMessage(pageItems[index - 1]!);
      notice = opened.notice;
      continue;
    }
    notice = `Unrecognized command: "${cmd}"`;
  }
  } finally {
    await progressiveCache.current?.stop();
    await operations.whenIdle();
  }
  return EXIT_CODES.ok;
}

export interface QuickAction {
  /** 1-based, as shown in the list — the caller still validates it against the current page's item count. */
  index: number;
  action: "reply" | "ai_reply" | "delete" | "move_to_inbox";
}

/**
 * Parses the "<n> r" / "<n> ;r" / "<n> d" list-view shorthand — select a
 * message and immediately reply / AI-reply / delete it in one typed
 * command instead of opening it first and pressing a key. Reply and
 * AI-reply are a navigation shortcut only: `openMessage`'s normal
 * confirm-before-send flow still runs unchanged (see CLAUDE.md's
 * "Interactive reply" — there is no path that skips that confirmation).
 */
export function parseQuickActionCommand(cmd: string): QuickAction | null {
  const match = /^(\d+)\s*(;r|r|d|i)$/.exec(cmd.trim());
  if (!match) return null;
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 1) return null;
  const action =
    match[2] === ";r"
      ? "ai_reply"
      : match[2] === "r"
        ? "reply"
        : match[2] === "i"
          ? "move_to_inbox"
          : "delete";
  return { index, action };
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
    const date = message.internalDate ? new Date(Number(message.internalDate)).toLocaleDateString() : "";
    const line = `${String(index + 1).padStart(2)}. ${unread} ${message.subject || "(no subject)"} — ${pc.dim(message.senderDisplay ?? "unknown")} ${pc.dim(date)}`;
    console.log(index === state.selectedRow ? pc.inverse(`> ${line}`) : `  ${line}`);
  });
  console.log("");
  if (state.notice) console.log(pc.yellow(state.notice));
  console.log(pc.dim(LIST_CONTROLS));
}

async function chooseTags(
  allTags: readonly string[],
  current: ReadonlySet<string>,
  labelNames: ReadonlyMap<string, string>
): Promise<Set<string>> {
  if (allTags.length === 0) return new Set();
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
    threadHasUserSentMessage: false
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
    if (action === "delete") {
      if (folderForLabelSnapshot(activeCached.labelSnapshot) === "trash") {
        edge = "Already in Trash; permanent deletion is never supported.";
        continue;
      }
      const trashed = await confirmAndTrash(
        gmailClient,
        messagesRepo,
        activeCached,
        runExclusive,
        ctx.clock.nowIso()
      );
      console.log(pc.dim("\nPress any key to return to the list."));
      await waitForKeypress();
      if (trashed) {
        onCacheProjected(trashed.gmailMessageId);
        return { navigation: "back", notice: "Moved to Trash. \";u\" undoes it.", trashedRecord: trashed };
      }
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
async function confirmAndTrash(
  gmailClient: GmailClient,
  messagesRepo: MessagesRepository,
  cached: CachedMessageRecord,
  runExclusive: ViewExclusiveRunner,
  nowIso: string
): Promise<CachedMessageRecord | null> {
  console.log("");
  const confirmed = await p.confirm({ message: `Move "${cached.subject || "(no subject)"}" to Trash?`, initialValue: true });
  if (p.isCancel(confirmed) || !confirmed) {
    console.log(pc.dim("Not deleted."));
    return null;
  }
  const outcome = await runExclusive(() => trashCached(gmailClient, messagesRepo, cached, nowIso));
  if (!outcome.ok) {
    console.error(pc.red(outcome.message));
    return null;
  }
  console.log(pc.green('Moved to Trash. Type ";u" to undo.'));
  return outcome.record;
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

/** List-view fast path ("<n> d"): trashes by ID without a live full-message fetch first, since deleting needs nothing from the body. */
async function handleQuickDelete(
  gmailClient: GmailClient,
  messagesRepo: MessagesRepository,
  cached: CachedMessageRecord,
  runExclusive: ViewExclusiveRunner,
  nowIso: string
): Promise<CachedMessageRecord | null> {
  return confirmAndTrash(gmailClient, messagesRepo, cached, runExclusive, nowIso);
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
  const rewritten = text.replace(/https?:\/\/[^\s)]+/g, (url) => {
    let index = indexByUrl.get(url);
    if (index === undefined) {
      index = links.length + 1;
      indexByUrl.set(url, index);
      links.push({ label: `[${index}]`, url });
    }
    return terminalHyperlink(pc.underline(pc.cyan(`[${index}]`)), url);
  });
  return { text: rewritten, links };
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
  console.log(pc.bold(message.subject || "(no subject)"));
  console.log(`From: ${message.from.displayName ?? message.from.address ?? "unknown"}`);
  if (message.to.length > 0) {
    console.log(`To: ${message.to.map((address) => address.displayName ?? address.address ?? "unknown").join(", ")}`);
  }
  if (message.dateHeader) console.log(`Date: ${message.dateHeader}`);
  console.log(pc.dim(`Read: ${isRead(labelIds) ? "yes" : "no"}`));
  console.log("");
  const content = message.bodyText ?? message.snippet;
  if (content.length === 0) {
    console.log(pc.dim("(no content)"));
    return [];
  }
  const { text, links } = shortenLinksForDisplay(content);
  console.log(text);
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
