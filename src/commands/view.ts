import * as p from "@clack/prompts";
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { runCache } from "./cache.js";
import { MessagesRepository, type CachedMessageRecord } from "../state/repositories/messages.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { SETTING_KEYS, SettingsRepository } from "../state/repositories/settings.js";
import { fetchMessageFull, headersFromMessage } from "../gmail/scanner.js";
import { buildNormalizedMessage, extractBodyParts } from "../gmail/normalize.js";
import { GMAIL_LABELS, isRead } from "../gmail/labels.js";
import { buildComposeTarget, buildReplyTarget, sendReply, type ReplyTarget } from "../gmail/reply.js";
import { draftNewEmail, draftReply } from "../ai/draft-reply.js";
import { resolveOpenAiCredentials } from "../ai/resolve-classifier.js";
import { readCommandLine, waitForKeypress } from "../core/keypress.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { EXIT_CODES } from "../core/errors.js";
import { withGoogleApiRetry } from "../core/api-retry.js";
import type { GmailClient } from "../gmail/client.js";
import type { AccountRecord, NormalizedMessage } from "../core/models.js";
import { projectHydratedCacheMessage } from "../gmail/cache-projection.js";
import { refreshViewCache } from "../gmail/view-sync.js";
import { listUserLabels } from "../gmail/custom-labels.js";
import { loadSentStyleExamples, type SentStyleExample } from "../gmail/sent-style.js";

export interface ViewOptions {
  limit?: number;
  /** Use the existing cache immediately instead of reconciling Gmail history on startup. */
  previous?: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_STEPS = [5, 10, 20, 50, 100] as const;

const LIST_CONTROLS =
  "type email number to open · ←/→ page · [ ] history · +/- size · l <n> · f filter · s search · c/a compose · u refresh · q quit";

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
    const settings = new SettingsRepository(ctx.db);
    const lastCacheAt = settings.get(account.accountHash, SETTING_KEYS.cacheLastRunAt);
    console.error(pc.dim(lastCacheAt ? `Updating mail cached ${formatAge(lastCacheAt)}...` : "Updating cached mail..."));

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
  let selectedTags = new Set<string>(
    all.some((message) => message.labelSnapshot.includes(GMAIL_LABELS.inbox)) ? [GMAIL_LABELS.inbox] : []
  );
  let search = "";
  let pageSize = options.limit ?? DEFAULT_PAGE_SIZE;
  let page = 0;
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
  let stylePromise: Promise<SentStyleExample[]> | null = null;
  const getStyleExamples = (): Promise<SentStyleExample[]> => {
    stylePromise ??= loadSentStyleExamples(gmailClient, account.emailDisplay ?? "");
    return stylePromise;
  };

  let notice: string | null = null;
  for (;;) {
    const visible = filterMessages(all, selectedTags, search);
    const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
    page = Math.min(page, totalPages - 1);
    const pageItems = visible.slice(page * pageSize, (page + 1) * pageSize);

    renderList(pageItems, { page, totalPages, pageSize, total: visible.length, selectedTags, search, labelNames, notice });
    notice = null;
    const input = await readCommandLine("> ", ["left", "right"]);
    if (input.kind === "cancel") break;
    if (input.kind === "key") {
      const forward = input.name === "right";
      if (forward ? page < totalPages - 1 : page > 0) {
        rememberView();
        page = forward ? page + 1 : page - 1;
      }
      continue;
    }
    const cmd = input.value.trim();

    if (cmd === "q") break;
    if (cmd === "") continue;
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
      await handleCompose(gmailClient, account.accountHash, cmd !== "c", ctx, getStyleExamples);
      // Hold the send confirmation on screen; the list redraw would wipe it.
      console.log(pc.dim("\nPress any key to return to the list."));
      await waitForKeypress();
      continue;
    }
    const index = Number(cmd);
    if (Number.isInteger(index) && index >= 1 && index <= pageItems.length) {
      let messageIndex = page * pageSize + index - 1;
      const browsingItems = visible;
      for (;;) {
        const opened = await openMessage(
          gmailClient,
          account.accountHash,
          account.emailDisplay ?? "",
          browsingItems[messageIndex]!,
          ctx,
          getStyleExamples,
          messageIndex > 0,
          messageIndex < browsingItems.length - 1
        );
        notice = opened.notice;
        if (opened.navigation === "previous") messageIndex -= 1;
        else if (opened.navigation === "next") messageIndex += 1;
        else break;
      }
      all = messagesRepo.listForAccount(account.accountHash);
      continue;
    }
    notice = `Unrecognized command: "${cmd}"`;
  }

  return EXIT_CODES.ok;
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
    console.log(
      `  ${String(index + 1).padStart(2)}. ${unread} ${message.subject || "(no subject)"} — ${pc.dim(message.senderDisplay ?? "unknown")} ${pc.dim(date)}`
    );
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
  getStyleExamples: () => Promise<SentStyleExample[]>,
  canGoPrevious: boolean,
  canGoNext: boolean
): Promise<OpenedMessage> {
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
  for (;;) {
    // Redrawn from scratch each time round so arrow navigation replaces the
    // message on screen instead of stacking another copy underneath it.
    renderMessage(message, labelIds);
    if (edge) console.log(pc.yellow(edge));
    console.log(pc.dim("\n[esc] list   [←/p] previous   [→/n] next   [r] reply   [;][r] AI reply"));
    edge = null;
    const action = await waitForViewerAction();
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
      else await handleAiReply(gmailClient, accountHash, ctx, message, getStyleExamples);
      // Hold the send confirmation on screen; the redraw above would wipe it.
      console.log(pc.dim("\nPress any key to return to the message."));
      await waitForKeypress();
    }
  }
}

function renderMessage(message: NormalizedMessage, labelIds: readonly string[]): void {
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
  console.log(content.length > 0 ? content : pc.dim("(no content)"));
}

type ViewerAction = "back" | "previous" | "next" | "reply" | "ai_reply";

interface OpenedMessage {
  navigation: "back" | "previous" | "next";
  /** Surfaced by the list after its own redraw, which would otherwise erase it. */
  notice: string | null;
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
    lastName = key.name;
    lastAt = Date.now();
  }
}

async function promptBody(message: string): Promise<string | null> {
  console.log("");
  console.log(pc.bold(message));
  console.log(pc.dim("Enter plain text on as many lines as needed. Finish with a single . on its own line."));
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  try {
    for (;;) {
      const line = await readline.question(lines.length === 0 ? "> " : "| ");
      if (line === ".") break;
      lines.push(line);
    }
  } catch {
    return null;
  } finally {
    readline.close();
  }
  const body = lines.join("\n").trim();
  return body || null;
}

async function reviewAiDraft(draft: string): Promise<string | null> {
  console.log("");
  console.log(pc.bold("AI draft"));
  console.log(draft);
  console.log("");
  const choice = await p.select({
    message: "What next?",
    options: [
      { value: "use", label: "Use this draft" },
      { value: "replace", label: "Replace the body" },
      { value: "discard", label: "Discard" }
    ]
  });
  if (p.isCancel(choice) || choice === "discard") return null;
  return choice === "replace" ? promptBody("Replacement body") : draft;
}

async function confirmAndSend(
  gmailClient: GmailClient,
  accountHash: string,
  target: ReplyTarget,
  body: string
): Promise<void> {
  console.log("");
  console.log(pc.bold(target.threadId ? "Reply preview" : "Message preview"));
  console.log(`To: ${target.to}`);
  console.log(`Subject: ${target.subject}`);
  console.log("");
  console.log(body);
  console.log("");
  const confirmed = await p.confirm({ message: "Send this exact message?", initialValue: false });
  if (p.isCancel(confirmed) || !confirmed) {
    console.log(pc.dim("Not sent."));
    return;
  }
  const lock = new ProcessLock(lockFilePath(accountHash));
  lock.acquire();
  try {
    await sendReply(gmailClient, target, body);
    console.log(pc.green("Sent."));
  } catch (error) {
    console.error(pc.red(`Failed to send: ${error instanceof Error ? error.message : String(error)}`));
  } finally {
    lock.release();
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
  getStyleExamples: () => Promise<SentStyleExample[]>
): Promise<void> {
  const target = buildReplyTarget(message);
  if (!target) {
    console.log(pc.red("This message has no usable address to reply to."));
    return;
  }
  const credentials = await resolveOpenAiCredentials({
    accountHash,
    credentialStore: ctx.credentialStore,
    config: ctx.config
  });
  if (!credentials) {
    console.log(pc.yellow("AI is not configured (no API key found) — use r for a manual reply instead."));
    return;
  }
  const guidance = await p.text({ message: "Optional guidance for the reply", placeholder: "Press Enter to let AI decide" });
  if (p.isCancel(guidance)) return;
  const spinner = p.spinner();
  spinner.start("Learning your style from recent Sent mail and drafting");
  const styleExamples = await getStyleExamples();
  const draft = await draftReply(message, credentials, { styleExamples, guidance });
  spinner.stop(draft ? `Draft ready (${styleExamples.length} style example(s)).` : "Could not draft a reply.");
  if (!draft) return;
  const edited = await reviewAiDraft(draft);
  if (!edited) {
    console.log(pc.dim("Discarded."));
    return;
  }
  await confirmAndSend(gmailClient, accountHash, target, edited);
}

async function handleCompose(
  gmailClient: GmailClient,
  accountHash: string,
  useAi: boolean,
  ctx: ReturnType<typeof bootstrap>,
  getStyleExamples: () => Promise<SentStyleExample[]>
): Promise<void> {
  const to = await p.text({ message: "To" });
  if (p.isCancel(to)) return;
  const subject = await p.text({ message: "Subject" });
  if (p.isCancel(subject)) return;
  const target = buildComposeTarget(to, subject);
  if (!target) {
    console.log(pc.red("Enter valid email addresses separated by commas; headers cannot contain line breaks."));
    return;
  }
  let body: string | null;
  if (!useAi) {
    body = await promptBody("Message body");
  } else {
    const purpose = await p.text({ message: "What should this email say?" });
    if (p.isCancel(purpose) || !purpose.trim()) return;
    const credentials = await resolveOpenAiCredentials({
      accountHash,
      credentialStore: ctx.credentialStore,
      config: ctx.config
    });
    if (!credentials) {
      console.log(pc.yellow("AI is not configured; use c to compose manually."));
      return;
    }
    const spinner = p.spinner();
    spinner.start("Learning your style from recent Sent mail and drafting");
    const styleExamples = await getStyleExamples();
    const draft = await draftNewEmail(
      { to: target.to, subject: target.subject, purpose },
      credentials,
      { styleExamples }
    );
    spinner.stop(draft ? `Draft ready (${styleExamples.length} style example(s)).` : "Could not draft the email.");
    body = draft ? await reviewAiDraft(draft) : null;
  }
  if (!body) {
    console.log(pc.dim("Cancelled."));
    return;
  }
  await confirmAndSend(gmailClient, accountHash, target, body);
}
