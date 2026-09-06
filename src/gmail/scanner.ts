import type { gmail_v1 } from "googleapis";
import type { GmailClient } from "./client.js";
import { headerMapFromList } from "./normalize.js";
import { apiErrorStatus, withGoogleApiRetry } from "../core/api-retry.js";

export const REQUIRED_METADATA_HEADERS = [
  "From",
  "Reply-To",
  "To",
  "Subject",
  "Date",
  "Message-ID",
  "Authentication-Results",
  "DKIM-Signature",
  "List-ID",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "Auto-Submitted",
  "Precedence"
] as const;

export interface MailboxProfile {
  emailAddress: string;
  historyId: string;
}

export async function fetchProfile(client: GmailClient): Promise<MailboxProfile> {
  const { data } = await withGoogleApiRetry(() => client.users.getProfile({ userId: "me" }));
  if (!data.emailAddress || !data.historyId) {
    throw new Error("Gmail profile response is missing emailAddress or historyId.");
  }
  return { emailAddress: data.emailAddress, historyId: data.historyId };
}

export interface MessageStub {
  id: string;
  threadId: string;
}

export interface ListMessagesParams {
  labelIds?: string[];
  /** A Gmail search query, usable together with or instead of labelIds (e.g. `gmail add`'s category search). */
  q?: string;
  includeSpamTrash: boolean;
  /** Stop paginating after this many results and report truncation, rather than looping forever. */
  safetyCapCount?: number;
}

export interface ListMessagesResult {
  messages: MessageStub[];
  truncated: boolean;
  /** Gmail's own (approximate) count of total matching messages, from the first page. */
  estimatedTotal: number | null;
}

/**
 * Fully paginates users.messages.list; never silently truncates unless
 * `safetyCapCount` is set, in which case the returned list is trimmed to
 * exactly that many IDs (not just "stop fetching more pages") — the point
 * of a cap is to bound how many subsequent messages.get calls happen, so
 * an over-full last page must not leak through uncapped.
 */
export async function listAllMessageIds(
  client: GmailClient,
  params: ListMessagesParams
): Promise<ListMessagesResult> {
  const messages: MessageStub[] = [];
  let pageToken: string | undefined;
  let truncated = false;
  let estimatedTotal: number | null = null;

  do {
    const { data } = await withGoogleApiRetry(() =>
      client.users.messages.list({
        userId: "me",
        ...(params.labelIds !== undefined ? { labelIds: params.labelIds } : {}),
        ...(params.q !== undefined ? { q: params.q } : {}),
        includeSpamTrash: params.includeSpamTrash,
        maxResults: 500,
        ...(pageToken !== undefined ? { pageToken } : {})
      })
    );
    if (estimatedTotal === null && typeof data.resultSizeEstimate === "number") {
      estimatedTotal = data.resultSizeEstimate;
    }
    for (const m of data.messages ?? []) {
      if (m.id && m.threadId) {
        messages.push({ id: m.id, threadId: m.threadId });
      }
    }
    pageToken = data.nextPageToken ?? undefined;

    if (params.safetyCapCount !== undefined && messages.length >= params.safetyCapCount) {
      truncated = pageToken !== undefined || messages.length > params.safetyCapCount;
      messages.length = params.safetyCapCount;
      break;
    }
  } while (pageToken);

  return { messages, truncated, estimatedTotal };
}

export async function fetchMessageMetadata(
  client: GmailClient,
  messageId: string
): Promise<gmail_v1.Schema$Message> {
  const { data } = await withGoogleApiRetry(() =>
    client.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: [...REQUIRED_METADATA_HEADERS]
    })
  );
  return data;
}

/**
 * A single cheap `users.labels.get` call for the current Inbox message
 * count — used as the "before" count for the run summary when an
 * incremental scan means we never list the whole Inbox.
 */
export async function fetchInboxMessageCount(client: GmailClient): Promise<number> {
  const { data } = await withGoogleApiRetry(() => client.users.labels.get({ userId: "me", id: "INBOX" }));
  return data.messagesTotal ?? 0;
}

export async function fetchMessageFull(
  client: GmailClient,
  messageId: string
): Promise<gmail_v1.Schema$Message> {
  const { data } = await withGoogleApiRetry(() =>
    client.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full"
    })
  );
  return data;
}

export function headersFromMessage(message: gmail_v1.Schema$Message) {
  return headerMapFromList(message.payload?.headers ?? undefined);
}

/**
 * Gmail history IDs are decimal numbers encoded as strings and can exceed
 * Number.MAX_SAFE_INTEGER, so comparing them requires BigInt, not string
 * comparison (which is wrong once digit counts differ, e.g. "99" > "100")
 * and not Number (which can silently lose precision).
 */
export function historyIdGreaterThan(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

export interface HistorySyncResult {
  /** Changed message ID -> its thread ID (both come straight from the history record, no extra fetch needed). */
  changedMessages: Map<string, string>;
  deletedMessageIds: Set<string>;
  endHistoryId: string;
  /** True when Gmail returned 404 for the starting marker; caller must fall back to a full rescan. */
  expiredMarker: boolean;
}

/**
 * Paginates users.history.list from a persisted marker and reconciles
 * every change into the set of messages that need re-evaluation. History
 * IDs are increasing but not contiguous; only an optimization over a full
 * rescan, never a correctness requirement.
 */
export async function listHistorySince(
  client: GmailClient,
  startHistoryId: string
): Promise<HistorySyncResult> {
  const changedMessages = new Map<string, string>();
  const deletedMessageIds = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId = startHistoryId;

  const record = (id: string | null | undefined, threadId: string | null | undefined): void => {
    // The `threadId ?? id` fallback only matters transiently: it seeds the
    // MessageStub used to fetch the message, and orchestrator.ts's
    // fetchAndNormalize always re-derives the real threadId from that
    // fetch response afterward, so a wrong guess here never survives past
    // the fetch that immediately follows.
    if (id) changedMessages.set(id, threadId ?? id);
  };

  try {
    do {
      const { data } = await withGoogleApiRetry(() =>
        client.users.history.list({
          userId: "me",
          startHistoryId,
          ...(pageToken !== undefined ? { pageToken } : {}),
          historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]
        })
      );

      for (const entry of data.history ?? []) {
        if (entry.id && historyIdGreaterThan(entry.id, latestHistoryId)) {
          latestHistoryId = entry.id;
        }
        for (const m of entry.messagesAdded ?? []) {
          record(m.message?.id, m.message?.threadId);
        }
        for (const m of entry.labelsAdded ?? []) {
          record(m.message?.id, m.message?.threadId);
        }
        for (const m of entry.labelsRemoved ?? []) {
          record(m.message?.id, m.message?.threadId);
        }
        for (const m of entry.messagesDeleted ?? []) {
          if (m.message?.id) {
            deletedMessageIds.add(m.message.id);
            changedMessages.delete(m.message.id);
          }
        }
      }
      pageToken = data.nextPageToken ?? undefined;
      if (data.historyId && historyIdGreaterThan(data.historyId, latestHistoryId)) {
        latestHistoryId = data.historyId;
      }
    } while (pageToken);
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return {
        changedMessages: new Map(),
        deletedMessageIds: new Set(),
        endHistoryId: startHistoryId,
        expiredMarker: true
      };
    }
    throw error;
  }

  return { changedMessages, deletedMessageIds, endHistoryId: latestHistoryId, expiredMarker: false };
}

function isNotFoundError(error: unknown): boolean {
  return apiErrorStatus(error) === 404;
}
