export const GMAIL_LABELS = {
  inbox: "INBOX",
  spam: "SPAM",
  trash: "TRASH",
  unread: "UNREAD",
  starred: "STARRED",
  important: "IMPORTANT",
  sent: "SENT",
  categoryPromotions: "CATEGORY_PROMOTIONS",
  categorySocial: "CATEGORY_SOCIAL",
  categoryUpdates: "CATEGORY_UPDATES",
  categoryForums: "CATEGORY_FORUMS"
} as const;

export function hasLabel(labelIds: readonly string[], label: string): boolean {
  return labelIds.includes(label);
}

export function isRead(labelIds: readonly string[]): boolean {
  return !hasLabel(labelIds, GMAIL_LABELS.unread);
}

export function isInInbox(labelIds: readonly string[]): boolean {
  return hasLabel(labelIds, GMAIL_LABELS.inbox);
}

export function isNativeSpam(labelIds: readonly string[]): boolean {
  return hasLabel(labelIds, GMAIL_LABELS.spam);
}

export function isPromotionCategory(labelIds: readonly string[]): boolean {
  return hasLabel(labelIds, GMAIL_LABELS.categoryPromotions);
}

/**
 * A message carries a preexisting STARRED/IMPORTANT label the app did not
 * attribute to itself in the action ledger. Gmail does not reveal whether
 * its own classifier or the user applied IMPORTANT, so both are treated as
 * user-owned unless this app's ledger says otherwise.
 */
export function hasUnattributedProtectionLabel(
  labelIds: readonly string[],
  appAttributedLabels: ReadonlySet<"STARRED" | "IMPORTANT">
): boolean {
  if (hasLabel(labelIds, GMAIL_LABELS.starred) && !appAttributedLabels.has("STARRED")) {
    return true;
  }
  if (hasLabel(labelIds, GMAIL_LABELS.important) && !appAttributedLabels.has("IMPORTANT")) {
    return true;
  }
  return false;
}

/** Bulk-mail signal from headers alone, independent of AI. */
export function hasBulkHeaderSignal(headers: {
  listId: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
}): boolean {
  if (headers.listId !== null) {
    return true;
  }
  if (headers.autoSubmitted !== null && headers.autoSubmitted.toLowerCase() !== "no") {
    return true;
  }
  if (headers.precedence !== null && /bulk|list|junk/i.test(headers.precedence)) {
    return true;
  }
  return false;
}
