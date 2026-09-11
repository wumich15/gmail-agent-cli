import { GMAIL_LABELS } from "./labels.js";

/** The four mailbox locations exposed by gmail view's top navigation bar. */
export type ViewFolderId = "inbox" | "archive" | "trash" | "spam";

export interface ViewFolderDefinition {
  id: ViewFolderId;
  label: string;
  list: {
    labelIds?: string[];
    q?: string;
    includeSpamTrash: boolean;
  };
}

/**
 * Kept in display order. Gmail has no ARCHIVE system label, so Archive is
 * loaded through Gmail's documented `in:archive` search operator.
 */
export const VIEW_FOLDERS: readonly ViewFolderDefinition[] = [
  {
    id: "inbox",
    label: "Inbox",
    list: { labelIds: [GMAIL_LABELS.inbox], includeSpamTrash: false }
  },
  {
    id: "archive",
    label: "Archive",
    list: { q: "in:archive", includeSpamTrash: false }
  },
  {
    id: "trash",
    label: "Trash",
    list: { labelIds: [GMAIL_LABELS.trash], includeSpamTrash: true }
  },
  {
    id: "spam",
    label: "Spam",
    list: { labelIds: [GMAIL_LABELS.spam], includeSpamTrash: true }
  }
] as const;

const VIEW_FOLDER_BY_ID = new Map(VIEW_FOLDERS.map((folder) => [folder.id, folder]));

export function viewFolderDefinition(id: ViewFolderId): ViewFolderDefinition {
  const folder = VIEW_FOLDER_BY_ID.get(id);
  if (!folder) throw new Error(`Unknown Gmail view folder: ${id}`);
  return folder;
}

/**
 * Assigns every cached row to at most one top-level folder. The precedence
 * handles transient/odd multi-label states deterministically, and prevents a
 * trashed or spam message from also appearing as archived merely because it
 * lacks INBOX. Sent-only and Draft-only rows are outside gmail view.
 */
export function folderForLabelSnapshot(labelIds: readonly string[]): ViewFolderId | null {
  if (labelIds.includes(GMAIL_LABELS.trash)) return "trash";
  if (labelIds.includes(GMAIL_LABELS.spam)) return "spam";
  if (labelIds.includes(GMAIL_LABELS.inbox)) return "inbox";
  if (labelIds.includes(GMAIL_LABELS.sent) || labelIds.includes(GMAIL_LABELS.draft)) return null;
  return "archive";
}

export function isViewCacheMessage(labelIds: readonly string[]): boolean {
  return folderForLabelSnapshot(labelIds) !== null;
}

export function messageIsInViewFolder(labelIds: readonly string[], folder: ViewFolderId): boolean {
  return folderForLabelSnapshot(labelIds) === folder;
}

/** Local subject/sender search intentionally remains an Inbox-only feature. */
export function viewFolderSupportsSearch(folder: ViewFolderId): boolean {
  return folder === "inbox";
}

/** Left/right navigation wraps around the fixed top-bar order. */
export function adjacentViewFolder(current: ViewFolderId, direction: "left" | "right"): ViewFolderId {
  const index = VIEW_FOLDERS.findIndex((folder) => folder.id === current);
  const offset = direction === "right" ? 1 : -1;
  return VIEW_FOLDERS[(index + offset + VIEW_FOLDERS.length) % VIEW_FOLDERS.length]!.id;
}
