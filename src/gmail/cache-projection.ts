import type { gmail_v1 } from "googleapis";
import type { CachedMessageRecord } from "../state/repositories/messages.js";
import { buildNormalizedMessage, extractBodyParts } from "./normalize.js";
import { GMAIL_LABELS } from "./labels.js";
import { headersFromMessage, type MessageStub } from "./scanner.js";
import { isViewCacheMessage } from "./view-folders.js";

export type CacheProjectionScope = "working_set" | "view";

/** Builds only the offline projection; message bodies never leave this call. */
export function projectHydratedCacheMessage(
  accountHash: string,
  userEmail: string,
  processedAt: string,
  stub: MessageStub,
  raw: gmail_v1.Schema$Message,
  existing: CachedMessageRecord | null,
  scope: CacheProjectionScope = "working_set"
): CachedMessageRecord | null {
  if (raw.id && raw.id !== stub.id) throw new Error("Gmail returned a different message ID.");
  const labelIds = raw.labelIds ?? [];
  // Cleanup only works against Inbox/Spam, while gmail view deliberately
  // retains its broader Inbox/Archive/Trash/Spam surface. Callers choose the
  // scope explicitly so broadening the viewer never broadens automation.
  const inWorkingSet = labelIds.includes(GMAIL_LABELS.inbox) || labelIds.includes(GMAIL_LABELS.spam);
  if (scope === "working_set" ? !inWorkingSet : !isViewCacheMessage(labelIds)) return null;

  const threadId = raw.threadId ?? stub.threadId;
  const { plain, html } = extractBodyParts(raw.payload ?? undefined);
  const normalized = buildNormalizedMessage({
    gmailMessageId: stub.id,
    gmailThreadId: threadId,
    historyId: raw.historyId ?? "0",
    internalDate: raw.internalDate ?? "0",
    labelIds,
    snippet: raw.snippet ?? "",
    headers: headersFromMessage(raw),
    htmlBody: html,
    plainBody: plain,
    userEmail,
    threadHasUserSentMessage: false
  });
  // Label changes alter policy inputs, even though the content hash excludes
  // labels. Invalidating completed evaluation queues a live work pass after
  // cache advances its history marker (for example, to archive newly read mail).
  const sameLabels = existing !== null &&
    JSON.stringify([...new Set(existing.labelSnapshot)].sort()) === JSON.stringify([...new Set(labelIds)].sort());
  const preserveAssessment = existing !== null && existing.contentHash === normalized.contentHash && sameLabels;

  return {
    accountHash,
    gmailMessageId: stub.id,
    gmailThreadId: threadId,
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
    processedAt: preserveAssessment ? existing.processedAt : processedAt,
    subject: normalized.subject || null,
    senderDisplay: normalized.from.displayName ?? normalized.from.address,
    internalDate: normalized.internalDate,
    category: preserveAssessment ? existing.category : null,
    assessmentHadEvent: preserveAssessment ? existing.assessmentHadEvent : null
  };
}
