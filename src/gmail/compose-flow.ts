import * as p from "@clack/prompts";
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import type { CliContext } from "../core/bootstrap.js";
import { buildComposeTarget, sendReply, type ReplyTarget } from "./reply.js";
import { draftNewEmail } from "../ai/draft-reply.js";
import { resolveOpenAiCredentials } from "../ai/resolve-classifier.js";
import type { ResolvedOpenAiCredentials } from "../ai/resolve-classifier.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import type { GmailClient } from "./client.js";

/**
 * The compose/send flow shared by `gmail view`'s "c"/"a"/";c" commands and
 * the standalone `gmail send` command, so the two never drift on the one
 * property that matters most: nothing here ever calls `sendReply` without
 * first showing the user the exact final To/Subject/Body and getting an
 * explicit, default-no confirmation (see CLAUDE.md's "Interactive mail").
 */

export async function promptBody(message: string): Promise<string | null> {
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

export async function reviewAiDraft(draft: string): Promise<string | null> {
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

/**
 * The single, narrow point that actually shows the exact final message and
 * calls `sendReply`/`messages.send`. Returns whether it actually sent, so a
 * caller (like `gmail send`'s exit code) can tell "declined/failed" from
 * "sent" without needing its own confirmation logic.
 */
export async function confirmAndSend(
  gmailClient: GmailClient,
  accountHash: string,
  target: ReplyTarget,
  body: string
): Promise<boolean> {
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
    return false;
  }
  const lock = new ProcessLock(lockFilePath(accountHash));
  lock.acquire();
  try {
    await sendReply(gmailClient, target, body);
    console.log(pc.green("Sent."));
    return true;
  } catch (error) {
    console.error(pc.red(`Failed to send: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  } finally {
    lock.release();
  }
}

export interface ComposePrefill {
  /** Skips the "To" prompt when provided (e.g. `gmail send someone@example.com`). */
  to?: string;
  /** Skips the "Subject" prompt when provided (e.g. `gmail send --subject "..."`). */
  subject?: string;
}

/**
 * Composes and (on confirmation) sends one new message. Recipient and
 * subject are always either a value the user typed/passed on the command
 * line or a value read back from `p.text` — never AI-derived, matching
 * every other outbound path in this app. `useAi` picks manual body entry
 * vs. an AI draft that imitates the account's saved writing style (see
 * `gmail/writing-style.ts`); either way the user reviews the exact body
 * before `confirmAndSend` shows the final preview and asks to send.
 */
export async function handleCompose(
  gmailClient: GmailClient,
  accountHash: string,
  useAi: boolean,
  ctx: CliContext,
  getStyleProfile: (credentials: ResolvedOpenAiCredentials, forceRefresh?: boolean) => Promise<string | null>,
  prefill: ComposePrefill = {}
): Promise<boolean> {
  let to = prefill.to;
  if (to === undefined) {
    const input = await p.text({ message: "To" });
    if (p.isCancel(input)) return false;
    to = input;
  }
  let subject = prefill.subject;
  if (subject === undefined) {
    const input = await p.text({ message: "Subject" });
    if (p.isCancel(input)) return false;
    subject = input;
  }
  const target = buildComposeTarget(to, subject);
  if (!target) {
    console.log(pc.red("Enter valid email addresses separated by commas; headers cannot contain line breaks."));
    return false;
  }
  let body: string | null;
  if (!useAi) {
    body = await promptBody("Message body");
  } else {
    const purpose = await p.text({ message: "What should this email say?" });
    if (p.isCancel(purpose) || !purpose.trim()) return false;
    const credentials = await resolveOpenAiCredentials(
      { accountHash, credentialStore: ctx.credentialStore, config: ctx.config },
      "compose"
    );
    if (!credentials) {
      console.log(pc.yellow("AI is not ready; check `gmail setup`, or compose manually instead."));
      return false;
    }
    const spinner = p.spinner();
    spinner.start("Drafting");
    // Reuses the persisted writing-style profile (computed once from a
    // Sent-mail sample and saved to SQLite) instead of re-deriving it —
    // see gmail/writing-style.ts.
    const styleProfile = await getStyleProfile(credentials);
    const draft = await draftNewEmail({ to: target.to, subject: target.subject, purpose }, credentials, { styleProfile });
    spinner.stop(draft ? "Draft ready." : "Could not draft the email.");
    body = draft ? await reviewAiDraft(draft) : null;
  }
  if (!body) {
    console.log(pc.dim("Cancelled."));
    return false;
  }
  return confirmAndSend(gmailClient, accountHash, target, body);
}
