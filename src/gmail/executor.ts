import type { GmailClient } from "./client.js";
import { GMAIL_LABELS } from "./labels.js";
import { withGoogleApiRetry } from "../core/google-api-retry.js";

const BATCH_MODIFY_MAX_IDS = 1000;

export interface LabelMutation {
  addLabelIds: readonly string[];
  removeLabelIds: readonly string[];
}

function mutationKey(mutation: LabelMutation): string {
  return JSON.stringify({
    add: [...mutation.addLabelIds].sort(),
    remove: [...mutation.removeLabelIds].sort()
  });
}

export interface GroupedMutationResult {
  succeededMessageIds: string[];
  /** One entry per message in a chunk whose batchModify call threw. */
  failedMessageIds: string[];
}

/**
 * Groups message IDs by their exact validated label mutation and issues
 * batchModify calls of at most 1,000 IDs each. Callers must not assume
 * batches execute in order or save quota units. A chunk that fails does
 * not stop the remaining chunks/groups — each is independent, matching
 * the design's "continue independent actions after an isolated failure"
 * requirement — so the caller gets back exactly which message IDs
 * actually succeeded versus failed.
 */
export async function applyGroupedLabelMutations(
  client: GmailClient,
  items: readonly { messageId: string; mutation: LabelMutation }[]
): Promise<GroupedMutationResult> {
  const groups = new Map<string, { mutation: LabelMutation; ids: string[] }>();
  for (const item of items) {
    const key = mutationKey(item.mutation);
    const group = groups.get(key);
    if (group) {
      group.ids.push(item.messageId);
    } else {
      groups.set(key, { mutation: item.mutation, ids: [item.messageId] });
    }
  }

  const succeededMessageIds: string[] = [];
  const failedMessageIds: string[] = [];

  for (const { mutation, ids } of groups.values()) {
    for (let i = 0; i < ids.length; i += BATCH_MODIFY_MAX_IDS) {
      const chunk = ids.slice(i, i + BATCH_MODIFY_MAX_IDS);
      try {
        await withGoogleApiRetry(() =>
          client.users.messages.batchModify({
            userId: "me",
            requestBody: {
              ids: chunk,
              addLabelIds: [...mutation.addLabelIds],
              removeLabelIds: [...mutation.removeLabelIds]
            }
          })
        );
        succeededMessageIds.push(...chunk);
      } catch {
        failedMessageIds.push(...chunk);
      }
    }
  }

  return { succeededMessageIds, failedMessageIds };
}

/** Trash a single message. Never calls delete/batchDelete. */
export async function trashMessage(client: GmailClient, messageId: string): Promise<void> {
  await withGoogleApiRetry(() => client.users.messages.trash({ userId: "me", id: messageId }));
}

/** Restores a trashed message and, if safe, its recorded prior labels. */
export async function untrashMessage(
  client: GmailClient,
  messageId: string,
  restoreLabelIds: readonly string[] = []
): Promise<void> {
  await withGoogleApiRetry(() => client.users.messages.untrash({ userId: "me", id: messageId }));
  if (restoreLabelIds.length > 0) {
    await withGoogleApiRetry(() =>
      client.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { addLabelIds: [...restoreLabelIds] }
      })
    );
  }
}

export function archiveMutation(): LabelMutation {
  return { addLabelIds: [], removeLabelIds: [GMAIL_LABELS.inbox] };
}

export function starAndImportantMutation(): LabelMutation {
  return { addLabelIds: [GMAIL_LABELS.starred, GMAIL_LABELS.important], removeLabelIds: [] };
}

export function starOnlyMutation(): LabelMutation {
  return { addLabelIds: [GMAIL_LABELS.starred], removeLabelIds: [] };
}

export function markImportantOnlyMutation(): LabelMutation {
  return { addLabelIds: [GMAIL_LABELS.important], removeLabelIds: [] };
}

export function combineMutations(mutations: readonly LabelMutation[]): LabelMutation {
  const add = new Set<string>();
  const remove = new Set<string>();
  for (const m of mutations) {
    for (const label of m.addLabelIds) add.add(label);
    for (const label of m.removeLabelIds) remove.add(label);
  }
  return { addLabelIds: [...add], removeLabelIds: [...remove] };
}
