import type { GmailClient } from "./client.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { buildNormalizedMessage, extractBodyParts } from "./normalize.js";
import { fetchMessageFull, headersFromMessage, listAllMessageIds } from "./scanner.js";
import { GMAIL_LABELS } from "./labels.js";

const SENT_SAMPLE_COUNT = 12;
const SENT_SAMPLE_CONCURRENCY = 6;
const MAX_EXAMPLE_CHARS = 700;
const MAX_TOTAL_CHARS = 5_000;

export interface SentStyleExample {
  subject: string;
  body: string;
}

/**
 * Loads a small, recent, in-memory-only sample of the user's Sent mailbox.
 * Bodies are normalized and bounded exactly like other AI input and are
 * never written to SQLite or logs.
 */
export async function loadSentStyleExamples(
  client: GmailClient,
  userEmail: string,
  limit: number = SENT_SAMPLE_COUNT
): Promise<SentStyleExample[]> {
  let result;
  try {
    result = await listAllMessageIds(client, {
      labelIds: [GMAIL_LABELS.sent],
      includeSpamTrash: false,
      safetyCapCount: limit
    });
  } catch {
    // Style matching is an enhancement, never a prerequisite for drafting.
    return [];
  }
  const examples = await mapWithConcurrency(result.messages, SENT_SAMPLE_CONCURRENCY, async (stub) => {
    try {
      const raw = await fetchMessageFull(client, stub.id);
      const { plain, html } = extractBodyParts(raw.payload ?? undefined);
      const normalized = buildNormalizedMessage({
        gmailMessageId: stub.id,
        gmailThreadId: raw.threadId ?? stub.threadId,
        historyId: raw.historyId ?? "0",
        internalDate: raw.internalDate ?? "0",
        labelIds: raw.labelIds ?? [],
        snippet: raw.snippet ?? "",
        headers: headersFromMessage(raw),
        htmlBody: html,
        plainBody: plain,
        userEmail,
        threadHasUserSentMessage: true
      });
      const body = (normalized.bodyText ?? normalized.snippet).trim().slice(0, MAX_EXAMPLE_CHARS);
      return body ? { subject: normalized.subject.slice(0, 160), body } : null;
    } catch {
      return null;
    }
  });

  const bounded: SentStyleExample[] = [];
  let total = 0;
  for (const example of examples) {
    if (!example) continue;
    const size = example.subject.length + example.body.length;
    if (bounded.length > 0 && total + size > MAX_TOTAL_CHARS) break;
    bounded.push(example);
    total += size;
  }
  return bounded;
}
