import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { EXIT_CODES } from "../core/errors.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { MessagesRepository } from "../state/repositories/messages.js";
import { dedupeStubs } from "../core/orchestrator.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import {
  fetchProfile,
  fetchMessageFull,
  headersFromMessage,
  listAllMessageIds,
  listHistorySince
} from "../gmail/scanner.js";
import { buildNormalizedMessage, extractBodyParts } from "../gmail/normalize.js";
import { GMAIL_LABELS } from "../gmail/labels.js";

const GMAIL_READ_CONCURRENCY = 5;

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
  try {
    const profile = await fetchProfile(gmailClient);

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

    console.error(pc.dim(`Caching ${stubs.length} message(s)...`));

    const messagesRepo = new MessagesRepository(ctx.db);
    let cached = 0;
    let failed = 0;
    await mapWithConcurrency(stubs, GMAIL_READ_CONCURRENCY, async (stub) => {
      try {
        const raw = await fetchMessageFull(gmailClient, stub.id);
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
        messagesRepo.upsert({
          accountHash: account.accountHash,
          gmailMessageId: stub.id,
          gmailThreadId: stub.threadId,
          contentHash: normalized.contentHash,
          labelSnapshot: labelIds,
          classifierVersion: null,
          promptVersion: null,
          schemaVersion: null,
          policyVersion: null,
          assessmentKind: null,
          assessmentConfidence: null,
          importanceScore: null,
          importanceConfidence: null,
          reasonCodes: null,
          processedAt: ctx.clock.nowIso()
        });
        cached += 1;
      } catch {
        failed += 1;
      }
    });

    // Same fence-then-reconcile pattern as a full `gmail work` scan: catch
    // anything that changed during this traversal so the marker we persist
    // doesn't leave a gap for the very next incremental run to miss.
    const postScanHistory = await listHistorySince(gmailClient, profile.historyId);
    const newHistoryMarker = postScanHistory.expiredMarker ? profile.historyId : postScanHistory.endHistoryId;
    new AccountsRepository(ctx.db).updateHistoryMarker(account.accountHash, newHistoryMarker, ctx.clock.nowIso());

    console.log(
      `Cached ${cached} message(s)${failed > 0 ? ` (${failed} failed and were skipped)` : ""}. ` +
        "Future `gmail`/`gmail work` runs will scan incrementally from here instead of re-fetching everything."
    );
    return failed > 0 ? EXIT_CODES.operationalFailure : EXIT_CODES.ok;
  } finally {
    lock.release();
  }
}
