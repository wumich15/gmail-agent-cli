import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount } from "./shared.js";
import { RuleGroupsRepository } from "../state/repositories/rule-groups.js";
import { findConflictingRuleGroup, groupBySubscriptionIdentity, proposeMatcher } from "../rules/resolver.js";
import { buildNormalizedMessage, headerMapFromList } from "../gmail/normalize.js";
import { newRuleGroupId } from "../core/ids.js";
import { EXIT_CODES, RuleConflictError } from "../core/errors.js";
import { trashMessage } from "../gmail/executor.js";
import { isOneClickPost, parseListUnsubscribeHeader } from "../unsubscribe/headers.js";
import { redactUrlForLogging } from "../unsubscribe/safe-http.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { listAllMessageIds } from "../gmail/scanner.js";
import type { NormalizedMessage } from "../core/models.js";
import type { GmailClient } from "../gmail/client.js";

export interface SpamOptions {
  yes: boolean;
  allMail: boolean;
  allowMailto: boolean;
  retryUnsubscribe: boolean;
}

/** Bounds how many search hits get fetched/considered per invocation; --limit-style safety cap, not a design limit. */
const SEARCH_SAFETY_CAP = 500;

interface SearchResult {
  messages: NormalizedMessage[];
  truncated: boolean;
  estimatedTotal: number | null;
}

async function searchRecentCandidates(
  gmailClient: GmailClient,
  category: string,
  includeArchived: boolean
): Promise<SearchResult> {
  // Default scope is Inbox + native Spam only, per the design's "recent
  // non-Trash mail" default. --all-mail explicitly widens this to
  // archived mail (Gmail's plain search already spans All Mail once you
  // drop the in:inbox/in:spam restriction, so "in:anywhere -in:trash"
  // here is the actually-wider query, not the narrower default).
  const q = includeArchived ? `${category} in:anywhere -in:trash` : `${category} (in:inbox OR in:spam)`;
  // includeSpamTrash must be explicit: Gmail's own API default excludes
  // SPAM/TRASH-labeled messages from search results regardless of what
  // the `q` string says, so a query built around `in:spam` would silently
  // never match a single actual spam-labeled message without this.
  const listResult = await listAllMessageIds(gmailClient, { q, includeSpamTrash: true, safetyCapCount: SEARCH_SAFETY_CAP });

  const results: NormalizedMessage[] = [];
  for (const stub of listResult.messages) {
    const { data: full } = await gmailClient.users.messages.get({
      userId: "me",
      id: stub.id,
      format: "metadata",
      metadataHeaders: [
        "From",
        "Subject",
        "List-ID",
        "List-Unsubscribe",
        "List-Unsubscribe-Post",
        "Authentication-Results"
      ]
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

export async function runSpam(category: string | undefined, options: SpamOptions): Promise<number> {
  if (!category) {
    console.error(
      pc.yellow(
        "An interactive sender picker isn't implemented in this build. Run `gmail add spam \"<category>\"` " +
          "with an explicit category, e.g. `gmail add spam \"LinkedIn\"`."
      )
    );
    return EXIT_CODES.invalidOrAuthRequired;
  }

  const ctx = bootstrap();
  const { account, gmailClient } = await resolveAccount(ctx);
  const lock = new ProcessLock(lockFilePath(account.accountHash));
  lock.acquire();

  try {
    return await runSpamLocked(category, options, ctx, account, gmailClient);
  } finally {
    lock.release();
  }
}

async function runSpamLocked(
  category: string,
  options: SpamOptions,
  ctx: ReturnType<typeof bootstrap>,
  account: Awaited<ReturnType<typeof resolveAccount>>["account"],
  gmailClient: GmailClient
): Promise<number> {
  const ruleGroupsRepo = new RuleGroupsRepository(ctx.db);
  const existingGroups = ruleGroupsRepo.list(account.accountHash);

  const searchResult = await searchRecentCandidates(gmailClient, category, options.allMail);
  const candidates = searchResult.messages;
  if (searchResult.truncated) {
    // CLAUDE.md: "never truncate silently. If a safety cap is configured,
    // state exactly how many messages remain."
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
    console.log(`No matching subscriptions found for "${category}".`);
    return EXIT_CODES.ok;
  }

  console.log(pc.bold(`Found ${identities.length} subscription identity(ies) for "${category}":`));
  const matchers = identities.map((identity) => proposeMatcher(identity));
  for (const [i, identity] of identities.entries()) {
    console.log(`  ${i + 1}. ${identity.displayLabel} (${identity.sampleMessageIds.length} message(s))`);
  }

  const conflict = findConflictingRuleGroup(existingGroups, "spam", matchers);
  if (conflict) {
    console.error(
      pc.red(
        `Refusing: this overlaps the existing important rule "${conflict.categoryName}" [${conflict.id}]. ` +
          "Remove or edit that rule first if you really want this treated as spam."
      )
    );
    throw new RuleConflictError(`Spam rule for "${category}" conflicts with important rule ${conflict.id}`);
  }

  if (!options.yes) {
    const confirmed = await p.confirm({
      message: `Create the "${category}" spam rule, trash current matches, and attempt unsubscribe?`
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
    action: "spam",
    enabled: true,
    matchers,
    createdAt: nowIso,
    updatedAt: nowIso
  });
  console.log(pc.green(`Created spam rule "${category}" [${ruleGroupId}].`));

  // Only trash candidates that actually resolved to one of the identities
  // this rule now covers — not every raw search hit. A message with
  // neither a List-ID nor a usable From address contributes to no
  // identity and must not be trashed just for appearing in the search.
  const resolvedMessageIds = new Set(identities.flatMap((identity) => identity.sampleMessageIds));
  let trashedCount = 0;
  for (const message of candidates) {
    if (!resolvedMessageIds.has(message.gmailMessageId)) continue;
    await trashMessage(gmailClient, message.gmailMessageId);
    trashedCount += 1;
  }
  console.log(`Trashed ${trashedCount} current matching message(s).`);

  let unsubHandled = 0;
  let unsubManual = 0;
  for (const identity of identities) {
    const sample = candidates.find((c) => c.gmailMessageId === identity.sampleMessageIds[0]);
    if (!sample?.listUnsubscribeHeader) continue;
    const parsed = parseListUnsubscribeHeader(sample.listUnsubscribeHeader);

    if (parsed.httpsUrl && isOneClickPost(sample.listUnsubscribePost)) {
      // A real RFC 8058 one-click POST requires verifying that a valid DKIM
      // signature's h= list covers List-Unsubscribe and
      // List-Unsubscribe-Post, which this build does not yet implement.
      // Falling back to manual handling is the spec-compliant safe default
      // whenever that verification is inconclusive.
      console.log(`  Manual unsubscribe needed for ${identity.displayLabel}: ${redactUrlForLogging(parsed.httpsUrl)}`);
      unsubManual += 1;
      continue;
    }

    if (parsed.mailto && options.allowMailto) {
      // parsed.mailto was already produced by parseMailtoUri inside
      // parseListUnsubscribeHeader — use it directly rather than
      // re-encoding just the address/subject into a new URI and
      // reparsing, which silently dropped the original body.
      const mailto = parsed.mailto;
      await gmailClient.users.messages.send({
        userId: "me",
        requestBody: {
          raw: Buffer.from(
            `To: ${mailto.address}\r\nSubject: ${mailto.subject ?? "Unsubscribe"}\r\n\r\n${mailto.body ?? ""}`
          ).toString("base64url")
        }
      });
      unsubHandled += 1;
      continue;
    }

    if (parsed.mailto && !options.allowMailto) {
      console.log(`  ${identity.displayLabel} needs mailto unsubscribe; pass --allow-mailto to send it.`);
      unsubManual += 1;
    } else if (parsed.httpUrl) {
      console.log(`  Manual unsubscribe link for ${identity.displayLabel}: ${redactUrlForLogging(parsed.httpUrl)}`);
      unsubManual += 1;
    }
  }
  console.log(`Unsubscribe: ${unsubHandled} sent, ${unsubManual} need manual action.`);

  return EXIT_CODES.ok;
}
