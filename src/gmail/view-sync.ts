import type { GmailAgentDatabase } from "../state/database.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { MessagesRepository, type CachedMessageRecord } from "../state/repositories/messages.js";
import { SETTING_KEYS, SettingsRepository } from "../state/repositories/settings.js";
import type { AccountRecord } from "../core/models.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { apiErrorStatus } from "../core/api-retry.js";
import type { GmailClient } from "./client.js";
import { projectHydratedCacheMessage } from "./cache-projection.js";
import { fetchMessageFull, fetchProfile, listHistorySince } from "./scanner.js";

const VIEW_REFRESH_CONCURRENCY = 8;

export interface ViewCacheRefreshResult {
  kind: "incremental" | "full_required";
  added: number;
  updated: number;
  removed: number;
  failed: number;
}

/**
 * Reconciles only Gmail history changes since the cache/work history fence.
 * A missing or expired fence deliberately requests a full `gmail cache`
 * fallback; history is an optimization, never a correctness boundary.
 */
export async function refreshViewCache(
  db: GmailAgentDatabase,
  client: GmailClient,
  account: AccountRecord,
  nowIso: string
): Promise<ViewCacheRefreshResult> {
  if (!account.historyMarker) {
    return { kind: "full_required", added: 0, updated: 0, removed: 0, failed: 0 };
  }

  const history = await listHistorySince(client, account.historyMarker);
  if (history.expiredMarker) {
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
        existingById.get(stub.id) ?? null
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
    new AccountsRepository(db).updateHistoryMarker(
      account.accountHash,
      failed === 0 ? history.endHistoryId : account.historyMarker,
      nowIso
    );
    new SettingsRepository(db).set(account.accountHash, SETTING_KEYS.viewLastRefreshAt, nowIso, nowIso);
  })();

  return {
    kind: "incremental",
    added,
    updated,
    removed: removedIds.size,
    failed
  };
}
