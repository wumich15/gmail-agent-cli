import type { gmail_v1 } from "googleapis";
import type { GmailClient } from "./client.js";
import { headerMapFromList } from "./normalize.js";
import { GMAIL_LABELS } from "./labels.js";
import { apiErrorStatus, withGoogleApiRetry } from "../core/api-retry.js";

const GMAIL_READ_TIMEOUT_MS = 20_000;
// A per-minute Gmail quota rejection cannot reliably clear inside the old
// three-attempt/~2.25-second retry window. Keep each network attempt bounded,
// but let reads use the same seven-attempt, minute-spanning retry budget as
// the shared Google retry policy. `withGoogleApiRetry` also pauses every
// queued worker when Gmail names the per-minute bucket, so these retries do
// not create a second request wave while that bucket is still exhausted.
const GMAIL_READ_RETRY_OPTIONS = { maxAttempts: 7, baseDelayMs: 1_000, maxDelayMs: 30_000 } as const;
const GMAIL_READ_REQUEST_OPTIONS = { timeout: GMAIL_READ_TIMEOUT_MS } as const;
const GMAIL_QUOTA_WEIGHT = {
  list: 0.25, // messages.list = 5 units vs. messages.get = 20
  history: 0.1, // history.list = 2 units
  label: 0.05, // labels.get/list = 1 unit
  message: 1,
  thread: 2
} as const;

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

// Keep the complete recursive MIME subtree. A fixed-depth fields selector
// silently dropped deeply nested content, changing hashes and AI evidence.
// Inline bodies come with messages.get; attachment endpoints are never read.
export const PROFILE_FIELDS = "emailAddress,historyId";
export const MESSAGE_LIST_FIELDS = "messages(id,threadId),nextPageToken,resultSizeEstimate";
export const MESSAGE_METADATA_FIELDS = "id,threadId,historyId,internalDate,labelIds,snippet,payload/headers";
export const MESSAGE_FULL_FIELDS =
  "id,threadId,historyId,internalDate,labelIds,snippet,payload(headers,mimeType,body/data,parts)";
export const INBOX_LABEL_FIELDS = "messagesTotal";
export const THREAD_MINIMAL_FIELDS = "messages/labelIds";
export const HISTORY_LIST_FIELDS =
  "history(id,messagesAdded/message(id,threadId),labelsAdded/message(id,threadId)," +
  "labelsRemoved/message(id,threadId),messagesDeleted/message(id,threadId)),nextPageToken,historyId";

export interface MailboxProfile {
  emailAddress: string;
  historyId: string;
}

export async function fetchProfile(client: GmailClient): Promise<MailboxProfile> {
  const { data } = await withGoogleApiRetry(
    () => client.users.getProfile({ userId: "me", fields: PROFILE_FIELDS }, GMAIL_READ_REQUEST_OPTIONS),
    GMAIL_READ_RETRY_OPTIONS,
    GMAIL_QUOTA_WEIGHT.label, "gmail.profile"
  );
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
  onProgress?: (discovered: number) => void;
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
  const seenIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  let truncated = false;
  let estimatedTotal: number | null = null;

  do {
    const { data } = await withGoogleApiRetry(
      () =>
        client.users.messages.list(
          {
            userId: "me",
            ...(params.labelIds !== undefined ? { labelIds: params.labelIds } : {}),
            ...(params.q !== undefined ? { q: params.q } : {}),
            includeSpamTrash: params.includeSpamTrash,
            maxResults: 500,
            fields: MESSAGE_LIST_FIELDS,
            ...(pageToken !== undefined ? { pageToken } : {})
          },
          GMAIL_READ_REQUEST_OPTIONS
        ),
      GMAIL_READ_RETRY_OPTIONS,
      GMAIL_QUOTA_WEIGHT.list, "gmail.messages.list"
    );
    if (estimatedTotal === null && typeof data.resultSizeEstimate === "number") {
      estimatedTotal = data.resultSizeEstimate;
    }
    for (const m of data.messages ?? []) {
      if (m.id && m.threadId && !seenIds.has(m.id)) {
        seenIds.add(m.id);
        messages.push({ id: m.id, threadId: m.threadId });
      }
    }
    pageToken = data.nextPageToken ?? undefined;

    params.onProgress?.(Math.min(messages.length, params.safetyCapCount ?? Infinity));
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) throw new Error("Gmail repeated a message-list page token.");
      seenPageTokens.add(pageToken);
    }
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
  const { data } = await withGoogleApiRetry(
    () =>
      client.users.messages.get(
        {
          userId: "me",
          id: messageId,
          format: "metadata",
          metadataHeaders: [...REQUIRED_METADATA_HEADERS],
          fields: MESSAGE_METADATA_FIELDS
        },
        GMAIL_READ_REQUEST_OPTIONS
      ),
    GMAIL_READ_RETRY_OPTIONS,
    GMAIL_QUOTA_WEIGHT.message, "gmail.messages.get.metadata"
  );
  return data;
}

/**
 * A single cheap `users.labels.get` call for the current Inbox message
 * count — used as the "before" count for the run summary when an
 * incremental scan means we never list the whole Inbox.
 */
export async function fetchInboxMessageCount(client: GmailClient): Promise<number> {
  const { data } = await withGoogleApiRetry(
    () => client.users.labels.get({ userId: "me", id: "INBOX", fields: INBOX_LABEL_FIELDS }, GMAIL_READ_REQUEST_OPTIONS),
    GMAIL_READ_RETRY_OPTIONS,
    GMAIL_QUOTA_WEIGHT.label, "gmail.labels.get"
  );
  return data.messagesTotal ?? 0;
}

/**
 * Returns the thread IDs that contain at least one message in Gmail's SENT
 * label. `messages.list` returns IDs and thread IDs without the 40-unit
 * `threads.get` cost, so the caller can answer the reply-protection question
 * with one cheap, paginated index instead of one expensive request per
 * trash candidate.
 */
export async function listSentThreadIds(client: GmailClient, onProgress?: (discovered: number) => void): Promise<Set<string>> {
  const result = await listAllMessageIds(client, {
    labelIds: [GMAIL_LABELS.sent],
    includeSpamTrash: false,
    ...(onProgress ? { onProgress } : {})
  });
  return new Set(result.messages.map((message) => message.threadId));
}

export async function fetchMessageFull(
  client: GmailClient,
  messageId: string
): Promise<gmail_v1.Schema$Message> {
  const { data } = await withGoogleApiRetry(
    () =>
      client.users.messages.get(
        {
          userId: "me",
          id: messageId,
          format: "full",
          fields: MESSAGE_FULL_FIELDS
        },
        GMAIL_READ_REQUEST_OPTIONS
      ),
    GMAIL_READ_RETRY_OPTIONS,
    GMAIL_QUOTA_WEIGHT.message, "gmail.messages.get.full"
  );
  return data;
}

export function headersFromMessage(message: gmail_v1.Schema$Message) {
  return headerMapFromList(message.payload?.headers ?? undefined);
}

/**
 * True if any message in the thread carries Gmail's own SENT label — the
 * "thread contains a message sent by the user" protection signal CLAUDE.md
 * requires. Uses `format=minimal` (labelIds only, no headers/body) since
 * that's all this needs, but `threads.get` still costs 40 quota units
 * regardless of format — double a `messages.get` (20 units) — so this is
 * passed to `withGoogleApiRetry` as weight 2, not the default weight 1, so
 * the shared rate limiter's pacing reflects its real quota cost instead of
 * silently under-pacing it (see api-retry.ts's `START_REQUESTS_PER_SECOND`
 * doc comment for the production incident this under-pacing caused).
 */
export async function fetchThreadHasUserSentMessage(client: GmailClient, threadId: string): Promise<boolean> {
  const { data } = await withGoogleApiRetry(
    () =>
      client.users.threads.get(
        { userId: "me", id: threadId, format: "minimal", fields: THREAD_MINIMAL_FIELDS },
        GMAIL_READ_REQUEST_OPTIONS
      ),
    // This is a safety-only lookup. If Gmail is already returning a per-user
    // quota error, retrying the 40-unit call multiplies the pressure and can
    // stall the whole run for a minute; the orchestrator treats an
    // inconclusive answer as Review instead.
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    GMAIL_QUOTA_WEIGHT.thread, "gmail.threads.get"
  );
  return (data.messages ?? []).some((m) => (m.labelIds ?? []).includes(GMAIL_LABELS.sent));
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
  startHistoryId: string,
  onProgress?: (discovered: number) => void
): Promise<HistorySyncResult> {
  const changedMessages = new Map<string, string>();
  const deletedMessageIds = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId = startHistoryId;
  const seenPageTokens = new Set<string>();

  const record = (id: string | null | undefined, threadId: string | null | undefined): void => {
    // The `threadId ?? id` fallback only matters transiently: it seeds the
    // MessageStub used to fetch the message, and orchestrator.ts's
    // fetchAndNormalize always re-derives the real threadId from that
    // fetch response afterward, so a wrong guess here never survives past
    // the fetch that immediately follows.
    if (id && !deletedMessageIds.has(id)) changedMessages.set(id, threadId ?? id);
  };

  try {
    do {
      const { data } = await withGoogleApiRetry(
        () =>
          client.users.history.list(
            {
              userId: "me",
              startHistoryId,
              ...(pageToken !== undefined ? { pageToken } : {}),
              historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
              fields: HISTORY_LIST_FIELDS
            },
            GMAIL_READ_REQUEST_OPTIONS
          ),
        GMAIL_READ_RETRY_OPTIONS,
        GMAIL_QUOTA_WEIGHT.history, "gmail.history.list"
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
      onProgress?.(changedMessages.size + deletedMessageIds.size);
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) throw new Error("Gmail repeated a history page token.");
        seenPageTokens.add(pageToken);
      }
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
