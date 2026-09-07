import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { EXIT_CODES } from "../core/errors.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { MessagesRepository } from "../state/repositories/messages.js";
import { dedupeStubs, resolvePostScanHistoryMarker } from "../core/orchestrator.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { fetchProfile, fetchMessageFull, headersFromMessage, listAllMessageIds } from "../gmail/scanner.js";
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
        // A prior `gmail work` run may have already classified this exact
        // message and cached its assessment (see core/orchestrator.ts's
        // assessment-reuse cache). `gmail cache` never classifies anything
        // itself, but blindly nulling those fields out here every time it
        // re-runs would silently destroy that cache and force every
        // message to be reclassified by AI again on the next `gmail work`
        // run — preserve the existing assessment whenever the content
        // hasn't actually changed; only a genuinely new/changed message
        // gets a blank (correctly stale) assessment.
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
        cached += 1;
      } catch {
        failed += 1;
      }
    });

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
    if (snapshotComplete) {
      const newHistoryMarker = await resolvePostScanHistoryMarker(gmailClient, profile.historyId);
      new AccountsRepository(ctx.db).updateHistoryMarker(account.accountHash, newHistoryMarker, ctx.clock.nowIso());
    }

    console.log(
      `Cached ${cached} message(s)${failed > 0 ? ` (${failed} failed and were skipped)` : ""}. ` +
        (snapshotComplete
          ? "Future `gmail`/`gmail work` runs will hydrate this cached backlog once, then scan incrementally from here."
          : "The snapshot was incomplete, so its history baseline was not advanced; a later full run can safely recover the omitted messages.")
    );
    return failed > 0 ? EXIT_CODES.operationalFailure : EXIT_CODES.ok;
  } finally {
    lock.release();
  }
}
