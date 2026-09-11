import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { openUrlInBrowser as openUrlInSystemBrowser } from "../core/open-browser.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { runCache } from "./cache.js";
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
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { EXIT_CODES } from "../core/errors.js";
import { withGoogleApiRetry } from "../core/api-retry.js";
import { trashMessage, untrashMessage } from "../gmail/executor.js";
import type { GmailClient } from "../gmail/client.js";
import type { AccountRecord, NormalizedMessage } from "../core/models.js";
import { projectHydratedCacheMessage } from "../gmail/cache-projection.js";
import { refreshViewCache } from "../gmail/view-sync.js";
import { listUserLabels } from "../gmail/custom-labels.js";
import { getWritingStyleProfile } from "../gmail/writing-style.js";

export interface ViewOptions {
  limit?: number;
  /** Use the existing cache immediately instead of reconciling Gmail history on startup. */
  previous?: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_STEPS = [5, 10, 20, 50, 100] as const;

const LIST_CONTROLS =
  "↑/↓ select · enter open · type email number to open · d delete highlighted row · dd delete it without asking · " +
  "<n> r/;r/d reply/AI-reply/delete without opening it · " +
  "←/→ page · [ ] history · esc home · +/- size · l <n> · f filter · s search · c/a compose · " +
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
  page: number;
  pageSize: number;
  selectedTags: Set<string>;
  search: string;
}

/** `gmail view` — an interactive terminal inbox with live incremental refresh, reading, composing, and replies. */
export async function runView(options: ViewOptions): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error(pc.red("gmail view is interactive and requires a terminal (stdin is not a TTY)."));
    return EXIT_CODES.safetyBlocked;
  }

  const ctx = bootstrap();
  let { account, gmailClient } = await resolveAccountSigningInIfNeeded(ctx);
  const initialCachedCount = new MessagesRepository(ctx.db).countForAccount(account.accountHash);
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

    refresh = await refreshViewCacheLocked(ctx, gmailClient, account);
    if (refresh.kind === "full_required") {
      console.error(
        pc.dim(
          (initialCachedCount > 0
            ? `The cache contains ${initialCachedCount} message(s), but it has no usable history checkpoint; refreshing the Inbox once. `
            : "There is no usable cache history checkpoint; refreshing the Inbox once. ") +
            "Use --previous to open the existing cache immediately."
        )
      );
      const cacheCode = await runCache();
      if (cacheCode !== EXIT_CODES.ok) {
        console.error(pc.yellow("The refresh was incomplete; showing every message that was cached successfully."));
      }
      account = new AccountsRepository(ctx.db).get(account.accountHash) ?? account;
    } else if (refresh.added + refresh.updated + refresh.removed > 0 || refresh.failed > 0) {
      console.error(
        pc.dim(
          `Inbox updated: ${refresh.added} new, ${refresh.updated} changed, ${refresh.removed} removed` +
            (refresh.failed > 0 ? `, ${refresh.failed} will retry later` : "") + "."
        )
      );
    } else {
      console.error(pc.dim("Inbox is up to date."));
    }
  }

  const messagesRepo = new MessagesRepository(ctx.db);
  let all = messagesRepo.listForAccount(account.accountHash);
  if (all.length === 0) {
    console.log(pc.yellow("No Inbox or Spam messages are currently cached."));
    return EXIT_CODES.ok;
  }

  let labelNames = options.previous ? systemLabelNames() : await loadLabelNames(gmailClient);
  const homeTags = new Set<string>(
    all.some((message) => message.labelSnapshot.includes(GMAIL_LABELS.inbox)) ? [GMAIL_LABELS.inbox] : []
  );
  let selectedTags = new Set<string>(homeTags);
  let search = "";
  let pageSize = options.limit ?? DEFAULT_PAGE_SIZE;
  let page = 0;
  /** Highlighted row within the current page — moved by ↑/↓, opened by Enter on an empty command. */
  let selectedRow = 0;
  /** The most recently trashed message from this session, for the ";u" quick-undo command. */
  let lastTrashed: CachedMessageRecord | null = null;
  const backStack: ListViewSnapshot[] = [];
  const forwardStack: ListViewSnapshot[] = [];
  const snapshotView = (): ListViewSnapshot => ({ page, pageSize, selectedTags: new Set(selectedTags), search });
  const restoreView = (snapshot: ListViewSnapshot): void => {
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
  for (;;) {
    const visible = filterMessages(all, selectedTags, search);
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
          messageIndex < visible.length - 1
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

    renderList(pageItems, { page, totalPages, pageSize, total: visible.length, selectedTags, search, labelNames, notice, selectedRow });
    notice = null;
    const input = await readCommandLine("> ", ["left", "right", "up", "down"]);
    if (input.kind === "cancel") {
      // Esc always goes "home" (default Inbox filter, no search, first
      // page) instead of quitting — quitting is q/Ctrl-C only. Useful
      // after a search or a deep filter/page-history dive.
      if (search || !sameSet(selectedTags, homeTags) || page !== 0) {
        rememberView();
        search = "";
        selectedTags = new Set(homeTags);
        page = 0;
        selectedRow = 0;
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
      const forward = input.name === "right";
      if (forward ? page < totalPages - 1 : page > 0) {
        rememberView();
        page = forward ? page + 1 : page - 1;
        selectedRow = 0;
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
      if (page < totalPages - 1) rememberView();
      page = Math.min(page + 1, totalPages - 1);
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
      }
      continue;
    }
    if (cmd === "f" || cmd === "t") {
      const nextTags = await chooseTags(collectDistinctTags(all), selectedTags, labelNames);
      if (!sameSet(nextTags, selectedTags)) {
        rememberView();
        selectedTags = nextTags;
        page = 0;
      }
      continue;
    }
    if (cmd === "s") {
      if (search) {
        rememberView();
        search = "";
        page = 0;
      }
      continue;
    }
    const searchMatch = /^s\s+(.+)$/.exec(cmd);
    if (searchMatch) {
      const nextSearch = searchMatch[1]!.trim();
      if (nextSearch !== search) {
        rememberView();
        search = nextSearch;
        page = 0;
      }
      continue;
    }
    if (cmd === "u") {
      const latestAccount = new AccountsRepository(ctx.db).get(account.accountHash) ?? account;
      refresh = await refreshViewCacheLocked(ctx, gmailClient, latestAccount);
      if (refresh.kind === "full_required") await runCache();
      account = new AccountsRepository(ctx.db).get(account.accountHash) ?? account;
      all = messagesRepo.listForAccount(account.accountHash);
      labelNames = await loadLabelNames(gmailClient);
      if (page !== 0) {
        rememberView();
        page = 0;
      }
      notice = "Inbox updated.";
      continue;
    }
    if (cmd === "c" || cmd === "a" || cmd === ";c") {
      // "c" asks how to write it, exactly as `gmail send` does; "a"/";c"
      // are the shortcut straight to an AI draft.
      await handleCompose(gmailClient, account.accountHash, cmd === "c" ? undefined : true, ctx, getStyleProfile);
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
      const profile = await getStyleProfile(credentials, true);
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
        await untrashMessage(gmailClient, toRestore.gmailMessageId, toRestore.labelSnapshot);
        messagesRepo.upsert(toRestore);
        all = messagesRepo.listForAccount(account.accountHash);
        lastTrashed = null;
        notice = `Restored "${toRestore.subject || "(no subject)"}".`;
      } catch (error) {
        notice = `Could not undo: ${error instanceof Error ? error.message : String(error)}`;
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
        const outcome = await trashCached(gmailClient, messagesRepo, target);
        if (outcome.ok) {
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
      // confirmation, same instant local-cache removal and ";u" undo.
      if (pageItems.length > 0) {
        const trashed = await handleQuickDelete(gmailClient, messagesRepo, pageItems[selectedRow]!);
        if (trashed) lastTrashed = trashed;
        console.log(pc.dim("\nPress any key to return to the list."));
        await waitForKeypress();
        all = messagesRepo.listForAccount(account.accountHash);
      }
      continue;
    }
    // "<n> r" / "<n> ;r" / "<n> d" — act on a message directly from the
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
          const trashed = await handleQuickDelete(gmailClient, messagesRepo, target);
          if (trashed) lastTrashed = trashed;
          console.log(pc.dim("\nPress any key to return to the list."));
          await waitForKeypress();
          all = messagesRepo.listForAccount(account.accountHash);
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

  return EXIT_CODES.ok;
}

export interface QuickAction {
  /** 1-based, as shown in the list — the caller still validates it against the current page's item count. */
  index: number;
  action: "reply" | "ai_reply" | "delete";
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
  const match = /^(\d+)\s*(;r|r|d)$/.exec(cmd.trim());
  if (!match) return null;
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 1) return null;
  const action = match[2] === ";r" ? "ai_reply" : match[2] === "r" ? "reply" : "delete";
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

async function refreshViewCacheLocked(
  ctx: ReturnType<typeof bootstrap>,
  gmailClient: GmailClient,
  account: AccountRecord
): Promise<Awaited<ReturnType<typeof refreshViewCache>>> {
  const lock = new ProcessLock(lockFilePath(account.accountHash));
  lock.acquire();
  try {
    return await refreshViewCache(ctx.db, gmailClient, account, ctx.clock.nowIso());
  } finally {
    lock.release();
  }
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

interface ListRenderState {
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
    pc.bold(`Gmail — ${state.total} message(s), page ${state.page + 1}/${state.totalPages} (page size ${state.pageSize})`)
  );
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
  /** Dispatches this action immediately on open (the "<n> r"/"<n> ;r" list shortcut) instead of waiting for a keypress first. Still goes through the normal confirm-before-send flow — this only skips the separate open-then-press-key navigation step. */
  initialAction?: "reply" | "ai_reply"
): Promise<OpenedMessage> {
  const messagesRepo = new MessagesRepository(ctx.db);
  let raw;
  const lock = new ProcessLock(lockFilePath(accountHash));
  try {
    // Keep the live read and its possible mark-read/cache projection in one
    // bounded critical section so a concurrent work run cannot archive or
    // trash the message between our fetch and local cache update.
    lock.acquire();
    raw = await fetchMessageFull(gmailClient, cached.gmailMessageId);
    let currentLabelIds = raw.labelIds ?? [];
    if (currentLabelIds.includes(GMAIL_LABELS.unread)) {
      try {
        await withGoogleApiRetry(
          () =>
            gmailClient.users.messages.modify({
              userId: "me",
              id: cached.gmailMessageId,
              requestBody: { removeLabelIds: [GMAIL_LABELS.unread] }
            }),
          {},
          0.25,
          "gmail.messages.mark_read"
        );
        currentLabelIds = currentLabelIds.filter((label) => label !== GMAIL_LABELS.unread);
        const projected = projectHydratedCacheMessage(
          accountHash,
          userEmail,
          ctx.clock.nowIso(),
          { id: cached.gmailMessageId, threadId: cached.gmailThreadId },
          { ...raw, labelIds: currentLabelIds },
          cached
        );
        if (projected) new MessagesRepository(ctx.db).upsert(projected);
      } catch (error) {
        console.error(
          pc.yellow(`Message opened, but it could not be marked read: ${error instanceof Error ? error.message : String(error)}`)
        );
      }
    }
    raw = { ...raw, labelIds: currentLabelIds };
  } catch (error) {
    return {
      navigation: "back",
      notice: `Could not open this message: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    lock.release();
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
        "\n[esc] list   [←/p] previous   [→/n] next   [r] reply   [;][r] AI reply   [d] delete" +
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
      if (action === "reply") await handleManualReply(gmailClient, accountHash, message);
      else await handleAiReply(gmailClient, accountHash, ctx, message, getStyleProfile);
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
      const trashed = await confirmAndTrash(gmailClient, messagesRepo, cached);
      console.log(pc.dim("\nPress any key to return to the list."));
      await waitForKeypress();
      if (trashed) return { navigation: "back", notice: "Moved to Trash. \";u\" undoes it.", trashedRecord: trashed };
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
 * record is exactly what a caller needs to offer that quick undo. Removes
 * the row from the local cache immediately so the list reflects the
 * change without waiting for the next Gmail history sync.
 */
async function confirmAndTrash(
  gmailClient: GmailClient,
  messagesRepo: MessagesRepository,
  cached: CachedMessageRecord
): Promise<CachedMessageRecord | null> {
  console.log("");
  const confirmed = await p.confirm({ message: `Move "${cached.subject || "(no subject)"}" to Trash?`, initialValue: true });
  if (p.isCancel(confirmed) || !confirmed) {
    console.log(pc.dim("Not deleted."));
    return null;
  }
  const outcome = await trashCached(gmailClient, messagesRepo, cached);
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
 * same reversible `messages.trash`, the same immediate local-cache
 * eviction, and the same returned record that makes ";u" able to undo it.
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
  cached: CachedMessageRecord
): Promise<TrashOutcome> {
  try {
    await trashMessage(gmailClient, cached.gmailMessageId);
    messagesRepo.delete(cached.accountHash, cached.gmailMessageId);
    return { ok: true, record: cached };
  } catch (error) {
    // Returned rather than printed: "dd" deliberately has no "press any key"
    // pause, so anything written here would be erased by the next redraw and
    // the message would appear to have been deleted when it was not.
    return { ok: false, message: `Could not move to Trash: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** List-view fast path ("<n> d"): trashes by ID without a live full-message fetch first, since deleting needs nothing from the body. */
async function handleQuickDelete(
  gmailClient: GmailClient,
  messagesRepo: MessagesRepository,
  cached: CachedMessageRecord
): Promise<CachedMessageRecord | null> {
  return confirmAndTrash(gmailClient, messagesRepo, cached);
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

type ViewerAction = "back" | "previous" | "next" | "reply" | "ai_reply" | "delete" | "links" | "open_link";

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
    if (key.name === "l") return "links";
    if (key.name === "o") return "open_link";
    lastName = key.name;
    lastAt = Date.now();
  }
}

async function handleManualReply(gmailClient: GmailClient, accountHash: string, message: NormalizedMessage): Promise<void> {
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
  await confirmAndSend(gmailClient, accountHash, target, body);
}

async function handleAiReply(
  gmailClient: GmailClient,
  accountHash: string,
  ctx: ReturnType<typeof bootstrap>,
  message: NormalizedMessage,
  getStyleProfile: (credentials: ResolvedOpenAiCredentials, forceRefresh?: boolean) => Promise<string | null>
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
  const styleProfile = await getStyleProfile(credentials);
  const draft = await draftReply(message, credentials, { styleProfile, guidance });
  spinner.stop(draft ? "Draft ready." : "Could not draft a reply.");
  if (!draft) return;
  const edited = await reviewAiDraft(draft);
  if (!edited) {
    console.log(pc.dim("Discarded."));
    return;
  }
  await confirmAndSend(gmailClient, accountHash, target, edited);
}
