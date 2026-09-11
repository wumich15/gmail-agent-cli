import type { GmailAgentDatabase } from "../state/database.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { MessagesRepository, type CachedMessageRecord } from "../state/repositories/messages.js";
import { SETTING_KEYS, SettingsRepository } from "../state/repositories/settings.js";
import type { AccountRecord } from "../core/models.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { apiErrorStatus } from "../core/api-retry.js";
import type { GmailClient } from "./client.js";
import { projectHydratedCacheMessage } from "./cache-projection.js";
import { fetchMessageFull, fetchProfile, historyIdGreaterThan, listHistorySince } from "./scanner.js";

const VIEW_REFRESH_CONCURRENCY = 8;

export interface ViewCacheRefreshResult {
  kind: "incremental" | "full_required";
  added: number;
  updated: number;
  removed: number;
  failed: number;
}

/**
 * Reconciles only Gmail history changes since the last complete four-folder
 * view snapshot. The cleanup cache's Inbox/Spam marker cannot certify that
 * Archive or Trash was ever loaded, so the viewer maintains its own fence.
 */
export async function refreshViewCache(
  db: GmailAgentDatabase,
  client: GmailClient,
  account: AccountRecord,
  nowIso: string
): Promise<ViewCacheRefreshResult> {
  const settings = new SettingsRepository(db);
  const viewMarker = settings.get(account.accountHash, SETTING_KEYS.viewHistoryMarker);
  if (!viewMarker) {
    return { kind: "full_required", added: 0, updated: 0, removed: 0, failed: 0 };
  }

  const history = await listHistorySince(client, viewMarker);
  if (history.expiredMarker) {
    db.transaction(() => {
      settings.delete(account.accountHash, SETTING_KEYS.viewHistoryMarker);
      settings.delete(account.accountHash, SETTING_KEYS.viewFullCacheAt);
    })();
    return { kind: "full_required", added: 0, updated: 0, removed: 0, failed: 0 };
  }

  const messages = new MessagesRepository(db);
  const existing = messages.listForAccount(account.accountHash);
  const existingById = new Map(existing.map((row) => [row.gmailMessageId, row]));
  const userEmail = account.emailDisplay ?? (await fetchProfile(client)).emailAddress;
  const changed = [...history.changedMessages.entries()].map(([id, threadId]) => ({ id, threadId }));
  const projections: CachedMessageRecord[] = [];
  const removedIds = new Set([...history.deletedMessageIds].filter((id) => existingById.has(id)));
  let added = 0;
  let updated = 0;
  let failed = 0;

  await mapWithConcurrency(changed, VIEW_REFRESH_CONCURRENCY, async (stub) => {
    try {
      const projection = projectHydratedCacheMessage(
        account.accountHash,
        userEmail,
        nowIso,
        stub,
        await fetchMessageFull(client, stub.id),
        existingById.get(stub.id) ?? null,
        "view"
      );
      if (projection === null) {
        if (existingById.has(stub.id)) removedIds.add(stub.id);
        return;
      }
      projections.push(projection);
      if (existingById.has(stub.id)) updated += 1;
      else added += 1;
    } catch (error) {
      // A message can disappear between the history page and hydration.
      // Gmail's 404 is conclusive and safe to evict; other failures keep
      // the old marker so the same change is retried next time.
      if (apiErrorStatus(error) === 404) {
        if (existingById.has(stub.id)) removedIds.add(stub.id);
      } else {
        failed += 1;
      }
    }
  });

  db.transaction(() => {
    messages.applyCacheBatch(account.accountHash, projections, [...removedIds]);
    if (failed === 0) {
      settings.set(account.accountHash, SETTING_KEYS.viewHistoryMarker, history.endHistoryId, nowIso);
      const accounts = new AccountsRepository(db);
      const latestAccount = accounts.get(account.accountHash);
      if (!latestAccount?.historyMarker || historyIdGreaterThan(history.endHistoryId, latestAccount.historyMarker)) {
        accounts.updateHistoryMarker(account.accountHash, history.endHistoryId, nowIso);
      }
    }
    settings.set(account.accountHash, SETTING_KEYS.viewLastRefreshAt, nowIso, nowIso);
  })();

  return {
    kind: "incremental",
    added,
    updated,
    removed: removedIds.size,
    failed
  };
}
