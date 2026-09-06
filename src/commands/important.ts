import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount } from "./shared.js";
import { RuleGroupsRepository } from "../state/repositories/rule-groups.js";
import {
  findConflictingRuleGroup,
  groupBySubscriptionIdentity,
  proposeBoundImportantMatcher
} from "../rules/resolver.js";
import { buildNormalizedMessage, headerMapFromList } from "../gmail/normalize.js";
import { normalizeAddress, normalizeListId } from "../rules/matcher.js";
import { newRuleGroupId } from "../core/ids.js";
import { EXIT_CODES, RuleConflictError } from "../core/errors.js";
import { applyGroupedLabelMutations, starAndImportantMutation } from "../gmail/executor.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { listAllMessageIds } from "../gmail/scanner.js";
import type { NormalizedMessage, RuleMatcher } from "../core/models.js";
import type { GmailClient } from "../gmail/client.js";

export interface ImportantOptions {
  yes: boolean;
}

/** Bounds how many search hits get fetched/considered per invocation; --limit-style safety cap, not a design limit. */
const SEARCH_SAFETY_CAP = 500;

interface SearchResult {
  messages: NormalizedMessage[];
  truncated: boolean;
  estimatedTotal: number | null;
}

async function searchRecentCandidates(gmailClient: GmailClient, category: string): Promise<SearchResult> {
  const listResult = await listAllMessageIds(gmailClient, {
    q: `${category} in:inbox`,
    includeSpamTrash: false,
    safetyCapCount: SEARCH_SAFETY_CAP
  });

  const results: NormalizedMessage[] = [];
  for (const stub of listResult.messages) {
    const { data: full } = await gmailClient.users.messages.get({
      userId: "me",
      id: stub.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "List-ID", "Authentication-Results"]
    });
    results.push(
      buildNormalizedMessage({
        gmailMessageId: stub.id,
        gmailThreadId: stub.threadId,
        historyId: full.historyId ?? "0",
        internalDate: full.internalDate ?? "0",
        labelIds: full.labelIds ?? [],
        snippet: full.snippet ?? "",
        headers: headerMapFromList(full.payload?.headers ?? undefined),
        htmlBody: null,
        plainBody: null,
        userEmail: "",
        threadHasUserSentMessage: false
      })
    );
  }
  return { messages: results, truncated: listResult.truncated, estimatedTotal: listResult.estimatedTotal };
}

export async function runImportant(category: string | undefined, options: ImportantOptions): Promise<number> {
  if (!category) {
    console.error(
      pc.yellow(
        "An interactive message/sender picker isn't implemented in this build. Run " +
          '`gmail add important "<category>"` with an explicit category.'
      )
    );
    return EXIT_CODES.invalidOrAuthRequired;
  }

  const ctx = bootstrap();
  const { account, gmailClient } = await resolveAccount(ctx);
  const lock = new ProcessLock(lockFilePath(account.accountHash));
  lock.acquire();

  try {
    return await runImportantLocked(category, options, ctx, account, gmailClient);
  } finally {
    lock.release();
  }
}

async function runImportantLocked(
  category: string,
  options: ImportantOptions,
  ctx: ReturnType<typeof bootstrap>,
  account: Awaited<ReturnType<typeof resolveAccount>>["account"],
  gmailClient: GmailClient
): Promise<number> {
  const ruleGroupsRepo = new RuleGroupsRepository(ctx.db);
  const existingGroups = ruleGroupsRepo.list(account.accountHash);

  const searchResult = await searchRecentCandidates(gmailClient, category);
  const candidates = searchResult.messages;
  if (searchResult.truncated) {
    console.log(
      pc.yellow(
        `Only scanned the ${candidates.length} most recent matching message(s)` +
          (searchResult.estimatedTotal !== null ? ` of an estimated ~${searchResult.estimatedTotal} total` : "") +
          " — re-run after handling these to catch the rest."
      )
    );
  }
  const identities = groupBySubscriptionIdentity(candidates);

  if (identities.length === 0) {
    console.log(`No matching Inbox mail found for "${category}".`);
    return EXIT_CODES.ok;
  }

  const matchers: RuleMatcher[] = [];
  const skippedNoBinding: string[] = [];
  for (const identity of identities) {
    const sample = candidates.find((c) => c.gmailMessageId === identity.sampleMessageIds[0])!;
    const bound = proposeBoundImportantMatcher(identity, sample);
    if (bound) {
      matchers.push(bound);
    } else {
      skippedNoBinding.push(identity.displayLabel);
    }
  }

  if (matchers.length === 0) {
    console.error(
      pc.red(
        "None of these senders have a currently-passing aligned DKIM/DMARC result to bind a " +
          "persistent important rule to, so no rule can be created safely. Star individual messages manually instead."
      )
    );
    return EXIT_CODES.safetyBlocked;
  }
  if (skippedNoBinding.length > 0) {
    console.log(pc.yellow(`Skipping (no aligned auth to bind): ${skippedNoBinding.join(", ")}`));
  }

  const conflict = findConflictingRuleGroup(existingGroups, "important", matchers);
  if (conflict) {
    console.error(
      pc.red(
        `Refusing: this overlaps the existing spam rule "${conflict.categoryName}" [${conflict.id}]. ` +
          "Remove or edit that rule first."
      )
    );
    throw new RuleConflictError(`Important rule for "${category}" conflicts with spam rule ${conflict.id}`);
  }

  if (!options.yes) {
    const confirmed = await p.confirm({
      message: `Create the "${category}" important rule and star/mark current matches?`
    });
    if (p.isCancel(confirmed) || !confirmed) {
      console.log("Cancelled. No changes were made.");
      return EXIT_CODES.safetyBlocked;
    }
  }

  const nowIso = ctx.clock.nowIso();
  const ruleGroupId = newRuleGroupId();
  ruleGroupsRepo.create({
    id: ruleGroupId,
    accountHash: account.accountHash,
    categoryName: category,
    action: "important",
    enabled: true,
    matchers,
    createdAt: nowIso,
    updatedAt: nowIso
  });
  console.log(pc.green(`Created important rule "${category}" [${ruleGroupId}].`));

  const boundIdentityKeys = new Set(
    identities
      .filter((identity) => matchers.some((m) => m.normalizedValue === (identity.listId ?? identity.fromAddress)))
      .map((identity) => identity.key)
  );
  const targets = candidates.filter((c) => {
    // Must use the same normalization resolver.ts used to build identity.key,
    // not the raw header value, or a List-ID like "Name <list.example.com>"
    // never matches its own normalized identity ("list.example.com").
    const key = c.listId
      ? `list_id:${normalizeListId(c.listId)}`
      : `from:${c.from.address ? normalizeAddress(c.from.address) : c.from.address}`;
    return boundIdentityKeys.has(key);
  });

  const result = await applyGroupedLabelMutations(
    gmailClient,
    targets.map((c) => ({ messageId: c.gmailMessageId, mutation: starAndImportantMutation() }))
  );
  console.log(`Starred and marked important: ${result.succeededMessageIds.length} current message(s).`);
  if (result.failedMessageIds.length > 0) {
    console.error(pc.red(`Failed to label ${result.failedMessageIds.length} message(s); rule was still created.`));
    return EXIT_CODES.operationalFailure;
  }

  return EXIT_CODES.ok;
}
