import type { GmailClient } from "./client.js";
import { apiErrorStatus, withGoogleApiRetry } from "../core/api-retry.js";

export interface UserLabel {
  id: string;
  name: string;
}

const LABEL_MUTATION_REQUEST_OPTIONS = { timeout: 20_000 } as const;
const LABEL_MUTATION_RETRY_OPTIONS = { maxAttempts: 2, baseDelayMs: 750, maxDelayMs: 5_000 } as const;

/**
 * Lists only the user's own custom labels (Gmail's system labels like
 * INBOX/STARRED/CATEGORY_* have `type: "system"` and are never candidates
 * for AI-assigned topical grouping or the "Calendar" label).
 */
export async function listUserLabels(client: GmailClient): Promise<UserLabel[]> {
  const { data } = await withGoogleApiRetry(
    () => client.users.labels.list({ userId: "me" }, { timeout: 20_000 }),
    { maxAttempts: 3, baseDelayMs: 750, maxDelayMs: 10_000 },
    0.05
  );
  const labels: UserLabel[] = [];
  for (const label of data.labels ?? []) {
    if (label.type === "user" && label.id && label.name) {
      labels.push({ id: label.id, name: label.name });
    }
  }
  return labels;
}

/**
 * Resolves a label name to its Gmail ID, matching case-insensitively
 * against `knownLabels` first so a slightly different casing never spawns
 * a duplicate label, and only calling `labels.create` when truly new.
 * `knownLabels` is mutated in place (keyed by lowercased name) so repeat
 * lookups for the same name within one run reuse the created ID.
 */
export async function getOrCreateLabelId(
  client: GmailClient,
  name: string,
  knownLabels: Map<string, string>
): Promise<string> {
  const key = name.trim().toLowerCase();
  const existing = knownLabels.get(key);
  if (existing) {
    return existing;
  }
  try {
    const { data } = await withGoogleApiRetry(
      () =>
        client.users.labels.create({
          userId: "me",
          requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" }
        }, LABEL_MUTATION_REQUEST_OPTIONS),
      LABEL_MUTATION_RETRY_OPTIONS,
      0.25
    );
    if (!data.id) {
      throw new Error(`Gmail did not return an ID for newly created label "${name}".`);
    }
    knownLabels.set(key, data.id);
    return data.id;
  } catch (error) {
    // A concurrent creator (this app's own earlier run, or the user in the
    // Gmail UI) may have created the exact-name label between our list and
    // this create call. Re-list once and adopt it rather than failing.
    if (apiErrorStatus(error) === 409) {
      const refreshed = await listUserLabels(client);
      const match = refreshed.find((l) => l.name.trim().toLowerCase() === key);
      if (match) {
        knownLabels.set(key, match.id);
        return match.id;
      }
    }
    throw error;
  }
}
