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
import { buildComposeTarget, sendReply, SendFailedError } from "../gmail/reply.js";
import { DEFAULT_LOCK_WAIT_MS, ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";
import { listAllMessageIds } from "../gmail/scanner.js";
import { withGoogleApiRetry } from "../core/api-retry.js";
import type { NormalizedMessage } from "../core/models.js";
import type { GmailClient } from "../gmail/client.js";

export interface SpamOptions {
  yes: boolean;
  allMail: boolean;
  allowMailto: boolean;
  retryUnsubscribe: boolean;
  /** Explicit `gmail add spam` is allowed to override an existing important rule. */
  overrideImportant?: boolean;
}

interface MailtoUnsubscribe {
  address: string;
  subject: string | null;
  body: string | null;
}

/**
 * Shows the exact outbound unsubscribe message and asks. Defaults to "no",
 * like every other send confirmation in this app, and refuses outright when
 * there is no terminal to ask — an unattended run must never be the thing
 * that sends mail on the user's behalf.
 */
async function confirmUnsubscribeSend(
  displayLabel: string,
  mailto: MailtoUnsubscribe,
  nonInteractive: boolean
): Promise<boolean> {
  if (nonInteractive || !process.stdin.isTTY) {
    console.log(
      `  ${displayLabel}: an unsubscribe email to ${mailto.address} needs your confirmation; run this without --yes in a terminal.`
    );
    return false;
  }
  console.log(pc.bold(`\n  Unsubscribe email for ${displayLabel}`));
  console.log(`    To:      ${mailto.address}`);
  console.log(`    Subject: ${mailto.subject ?? "Unsubscribe"}`);
  console.log(`    Body:    ${mailto.body ? mailto.body : "(empty)"}`);
  const confirmed = await p.confirm({ message: "Send exactly this email?", initialValue: false });
  return !p.isCancel(confirmed) && confirmed;
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
    const { data: full } = await withGoogleApiRetry(() =>
      gmailClient.users.messages.get({
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
      })
    );
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
  lock.acquire({ waitMs: DEFAULT_LOCK_WAIT_MS });

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
  if (conflict && !options.overrideImportant) {
    console.error(
      pc.red(
        `Refusing: this overlaps the existing important rule "${conflict.categoryName}" [${conflict.id}]. ` +
          "Remove or edit that rule first if you really want this treated as spam."
      )
    );
    throw new RuleConflictError(`Spam rule for "${category}" conflicts with important rule ${conflict.id}`);
  }
  if (conflict && options.overrideImportant) {
    console.log(
      pc.yellow(
        `Explicit spam request overrides the important rule "${conflict.categoryName}" [${conflict.id}].`
      )
    );
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
  let trashFailures = 0;
  for (const message of candidates) {
    if (!resolvedMessageIds.has(message.gmailMessageId)) continue;
    try {
      await trashMessage(gmailClient, message.gmailMessageId);
      trashedCount += 1;
    } catch {
      // One rejected message must not abandon the rest of the batch, nor the
      // unsubscribe reporting below: the rule is already saved, so aborting
      // here would leave the user with a half-applied command and no summary
      // of what actually happened.
      trashFailures += 1;
    }
  }
  console.log(
    `Trashed ${trashedCount} current matching message(s).` +
      (trashFailures > 0 ? ` ${trashFailures} could not be trashed and will be retried by a later run.` : "")
  );

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

      // This app has exactly one rule about outbound mail: nothing is ever
      // sent without the user first seeing that exact message and agreeing
      // to it. An unsubscribe is not an exception — it is a real email, to
      // an address chosen by a header the sender controls. A flag on the
      // command authorizes *considering* the method; it is not consent to
      // send this specific message, so the confirmation happens here, at
      // the send site, where it cannot be bypassed by a future caller.
      // Built and sent through the same hardened path as every other
      // outbound message (gmail/reply.ts): one validated recipient, header
      // values sanitized and RFC 2047-encoded, one narrow call site for
      // messages.send. Hand-assembling a second raw message here duplicated
      // that logic without its protections.
      const target = buildComposeTarget(mailto.address, mailto.subject ?? "Unsubscribe");
      if (!target) {
        console.log(`  ${identity.displayLabel}: the unsubscribe address in that header is not usable; handle it manually.`);
        unsubManual += 1;
        continue;
      }
      const confirmed = await confirmUnsubscribeSend(identity.displayLabel, mailto, options.yes);
      if (!confirmed) {
        unsubManual += 1;
        continue;
      }
      try {
        await sendReply(gmailClient, target, mailto.body ?? "");
        unsubHandled += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (error instanceof SendFailedError && error.ambiguous) {
          // The same "never retry an ambiguous outbound request" rule this
          // subsystem applies to its one-click POST: Gmail may already have
          // delivered this unsubscribe, so do not present it as something
          // still to be done.
          console.log(
            `  ${identity.displayLabel}: Gmail did not confirm the unsubscribe email (${detail}); ` +
              "it may already have been sent. Check your Sent mail before retrying."
          );
        } else {
          console.log(`  ${identity.displayLabel}: the unsubscribe email could not be sent (${detail}).`);
          unsubManual += 1;
        }
      }
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
