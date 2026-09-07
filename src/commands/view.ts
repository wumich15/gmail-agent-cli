import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount } from "./shared.js";
import { MessagesRepository, type CachedMessageRecord } from "../state/repositories/messages.js";
import { fetchMessageFull, headersFromMessage } from "../gmail/scanner.js";
import { buildNormalizedMessage, extractBodyParts } from "../gmail/normalize.js";
import { GMAIL_LABELS, isRead } from "../gmail/labels.js";
import { buildReplyTarget, sendReply, type ReplyTarget } from "../gmail/reply.js";
import { draftReply } from "../ai/draft-reply.js";
import { resolveOpenAiCredentials } from "../ai/resolve-classifier.js";
import { waitForKeypress } from "../core/keypress.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { EXIT_CODES } from "../core/errors.js";
import type { GmailClient } from "../gmail/client.js";
import type { NormalizedMessage } from "../core/models.js";

export interface ViewOptions {
  limit?: number;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * `gmail view` — a read-only terminal browser over `gmail cache`'s local
 * data (see CLAUDE.md's "gmail view"). Opening a message and sending a
 * reply are the only live Gmail calls it makes; the list itself never
 * touches the network.
 */
export async function runView(options: ViewOptions): Promise<number> {
  const ctx = bootstrap();
  const { account, gmailClient } = await resolveAccount(ctx);

  const all = new MessagesRepository(ctx.db).listForAccount(account.accountHash);
  if (all.length === 0) {
    console.log(pc.yellow("No cached messages yet. Run `gmail cache` first, then `gmail view`."));
    return EXIT_CODES.ok;
  }
  if (!process.stdin.isTTY) {
    console.error(pc.red("gmail view is interactive and requires a terminal (stdin is not a TTY)."));
    return EXIT_CODES.safetyBlocked;
  }

  const allTags = collectDistinctTags(all);
  const hiddenTags = new Set<string>();
  let pageSize = options.limit ?? DEFAULT_PAGE_SIZE;
  let page = 0;

  for (;;) {
    const visible = all.filter((m) => !m.labelSnapshot.some((l) => hiddenTags.has(l)));
    const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
    page = Math.min(page, totalPages - 1);
    const pageItems = visible.slice(page * pageSize, (page + 1) * pageSize);

    renderList(pageItems, { page, totalPages, pageSize, total: visible.length, hiddenTags });

    const input = await p.text({
      message: "Command",
      placeholder: "number to open · n/p page · l <n> limit · t tags · q quit"
    });
    if (p.isCancel(input)) break;
    const cmd = input.trim();

    if (cmd === "q" || cmd === "") {
      if (cmd === "q") break;
      continue;
    }
    if (cmd === "n") {
      page = Math.min(page + 1, totalPages - 1);
      continue;
    }
    if (cmd === "p") {
      page = Math.max(page - 1, 0);
      continue;
    }
    const limitMatch = /^l\s+(\d+)$/.exec(cmd);
    if (limitMatch) {
      pageSize = Math.max(1, Number(limitMatch[1]));
      page = 0;
      continue;
    }
    if (cmd === "t") {
      await toggleTags(allTags, hiddenTags);
      page = 0;
      continue;
    }
    const index = Number(cmd);
    if (Number.isInteger(index) && index >= 1 && index <= pageItems.length) {
      const chosen = pageItems[index - 1]!;
      await openMessage(gmailClient, account.accountHash, chosen, ctx);
      continue;
    }
    console.log(pc.yellow(`Unrecognized command: "${cmd}"`));
  }

  return EXIT_CODES.ok;
}

function collectDistinctTags(messages: readonly CachedMessageRecord[]): string[] {
  const tags = new Set<string>();
  for (const m of messages) {
    for (const label of m.labelSnapshot) {
      tags.add(label);
    }
  }
  return [...tags].sort();
}

interface ListRenderState {
  page: number;
  totalPages: number;
  pageSize: number;
  total: number;
  hiddenTags: ReadonlySet<string>;
}

function renderList(items: readonly CachedMessageRecord[], state: ListRenderState): void {
  console.log("");
  console.log(pc.bold(`Inbox cache — ${state.total} message(s), page ${state.page + 1}/${state.totalPages} (page size ${state.pageSize})`));
  if (state.hiddenTags.size > 0) {
    console.log(pc.dim(`Hidden tags: ${[...state.hiddenTags].join(", ")}`));
  }
  console.log("");
  if (items.length === 0) {
    console.log(pc.dim("  (no messages on this page)"));
  }
  items.forEach((m, i) => {
    const unread = !m.labelSnapshot.includes(GMAIL_LABELS.unread) ? " " : "*";
    const subject = m.subject || "(no subject)";
    const sender = m.senderDisplay ?? "(unknown sender)";
    console.log(`  ${String(i + 1).padStart(2)}. ${unread} ${subject} — ${pc.dim(sender)}`);
  });
  console.log("");
}

async function toggleTags(allTags: readonly string[], hiddenTags: Set<string>): Promise<void> {
  if (allTags.length === 0) {
    console.log(pc.dim("No tags found in the cache."));
    return;
  }
  const selected = await p.multiselect({
    message: "Visible tags (deselect to hide)",
    options: allTags.map((tag) => ({ value: tag, label: tag })),
    initialValues: allTags.filter((tag) => !hiddenTags.has(tag)),
    required: false
  });
  if (p.isCancel(selected)) {
    return;
  }
  hiddenTags.clear();
  for (const tag of allTags) {
    if (!selected.includes(tag)) {
      hiddenTags.add(tag);
    }
  }
}

async function openMessage(
  gmailClient: GmailClient,
  accountHash: string,
  cached: CachedMessageRecord,
  ctx: ReturnType<typeof bootstrap>
): Promise<void> {
  let raw;
  try {
    raw = await fetchMessageFull(gmailClient, cached.gmailMessageId);
  } catch (error) {
    console.error(pc.red(`Could not fetch this message: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  const headers = headersFromMessage(raw);
  const labelIds = raw.labelIds ?? [];
  const { plain, html } = extractBodyParts(raw.payload ?? undefined);
  const message = buildNormalizedMessage({
    gmailMessageId: cached.gmailMessageId,
    gmailThreadId: cached.gmailThreadId,
    historyId: raw.historyId ?? "0",
    internalDate: raw.internalDate ?? cached.internalDate ?? "0",
    labelIds,
    snippet: raw.snippet ?? "",
    headers,
    htmlBody: html,
    plainBody: plain,
    userEmail: "",
    threadHasUserSentMessage: false
  });

  renderMessage(message, labelIds);

  for (;;) {
    console.log(pc.dim("\n[esc] back to list   [r] reply   [;][r] AI-drafted reply"));
    const action = await waitForViewerAction();
    if (action === "back") {
      return;
    }
    if (action === "reply") {
      await handleManualReply(gmailClient, accountHash, ctx, message);
      continue;
    }
    if (action === "ai_reply") {
      await handleAiReply(gmailClient, accountHash, ctx, message);
      continue;
    }
  }
}

function renderMessage(message: NormalizedMessage, labelIds: readonly string[]): void {
  console.log("");
  console.log(pc.bold(message.subject || "(no subject)"));
  console.log(`From: ${message.from.displayName ?? message.from.address ?? "unknown"}`);
  if (message.to.length > 0) {
    console.log(`To: ${message.to.map((a) => a.displayName ?? a.address ?? "unknown").join(", ")}`);
  }
  if (message.dateHeader) {
    console.log(`Date: ${message.dateHeader}`);
  }
  console.log(pc.dim(`Read: ${isRead(labelIds) ? "yes" : "no"}`));
  console.log("");
  const content = message.bodyText ?? message.snippet;
  console.log(content.length > 0 ? content : pc.dim("(no content)"));
}

type ViewerAction = "back" | "reply" | "ai_reply";

/** Detects the ";" then "r" sequence (within 1s) for an AI-drafted reply, vs. a bare "r" for a manual one. */
async function waitForViewerAction(): Promise<ViewerAction> {
  let lastName: string | null = null;
  let lastAt = 0;
  for (;;) {
    const key = await waitForKeypress();
    if (key.name === "escape") {
      return "back";
    }
    if (key.name === "r" && lastName === ";" && Date.now() - lastAt < 1000) {
      return "ai_reply";
    }
    if (key.name === "r") {
      return "reply";
    }
    lastName = key.name;
    lastAt = Date.now();
  }
}

async function confirmAndSend(
  gmailClient: GmailClient,
  accountHash: string,
  target: ReplyTarget,
  body: string
): Promise<void> {
  console.log("");
  console.log(pc.bold("Reply preview"));
  console.log(`To: ${target.to}`);
  console.log(`Subject: ${target.subject}`);
  console.log("");
  console.log(body);
  console.log("");

  const confirmed = await p.confirm({ message: "Send this reply?", initialValue: false });
  if (p.isCancel(confirmed) || !confirmed) {
    console.log(pc.dim("Not sent."));
    return;
  }

  // Locked for the send itself only — gmail view is otherwise a read-heavy
  // interactive session with no reason to hold an exclusive lock for its
  // whole lifetime, but the actual outbound send is a real Gmail mutation
  // and must not race a concurrent gmail/gmail work run.
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

async function handleManualReply(
  gmailClient: GmailClient,
  accountHash: string,
  ctx: ReturnType<typeof bootstrap>,
  message: NormalizedMessage
): Promise<void> {
  const target = buildReplyTarget(message);
  if (!target) {
    console.log(pc.red("This message has no usable address to reply to."));
    return;
  }
  const body = await p.text({ message: `Reply to ${target.to}` });
  if (p.isCancel(body) || body.trim().length === 0) {
    console.log(pc.dim("Cancelled."));
    return;
  }
  await confirmAndSend(gmailClient, accountHash, target, body);
}

async function handleAiReply(
  gmailClient: GmailClient,
  accountHash: string,
  ctx: ReturnType<typeof bootstrap>,
  message: NormalizedMessage
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
    console.log(pc.yellow("AI is not configured (no API key found) — use \"r\" for a manual reply instead."));
    return;
  }

  const spinner = p.spinner();
  spinner.start("Drafting a reply with AI");
  const draft = await draftReply(message, credentials);
  spinner.stop(draft ? "Draft ready." : "Could not draft a reply.");
  if (!draft) {
    return;
  }

  console.log("");
  console.log(pc.bold("AI-drafted reply"));
  console.log(draft);

  const choice = await p.select({
    message: "What next?",
    options: [
      { value: "send", label: "Send this reply" },
      { value: "discard", label: "Discard" }
    ]
  });
  if (p.isCancel(choice) || choice === "discard") {
    console.log(pc.dim("Discarded."));
    return;
  }

  await confirmAndSend(gmailClient, accountHash, target, draft);
}
