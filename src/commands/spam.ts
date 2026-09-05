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
import {
  isOneClickPost,
  parseListUnsubscribeHeader,
  parseMailtoUri
} from "../unsubscribe/headers.js";
import { redactUrlForLogging } from "../unsubscribe/safe-http.js";
import type { NormalizedMessage } from "../core/models.js";
import type { GmailClient } from "../gmail/client.js";

export interface SpamOptions {
  yes: boolean;
  allMail: boolean;
  allowMailto: boolean;
  retryUnsubscribe: boolean;
}

async function searchRecentCandidates(
  gmailClient: GmailClient,
  category: string,
  includeArchived: boolean
): Promise<NormalizedMessage[]> {
  const q = includeArchived ? category : `${category} in:anywhere -in:trash`;
  const { data } = await gmailClient.users.messages.list({ userId: "me", q, maxResults: 50 });
  const results: NormalizedMessage[] = [];
  for (const stub of data.messages ?? []) {
    if (!stub.id || !stub.threadId) continue;
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
  return results;
}

export async function runSpam(category: string | undefined, options: SpamOptions): Promise<number> {
  if (!category) {
    console.error(
      pc.yellow(
        "An interactive sender picker isn't implemented in this build. Run `gmail spam \"<category>\"` " +
          "with an explicit category, e.g. `gmail spam \"LinkedIn\"`."
      )
    );
    return EXIT_CODES.invalidOrAuthRequired;
  }

  const ctx = bootstrap();
  const { account, gmailClient } = await resolveAccount(ctx);
  const ruleGroupsRepo = new RuleGroupsRepository(ctx.db);
  const existingGroups = ruleGroupsRepo.list(account.accountHash);

  const candidates = await searchRecentCandidates(gmailClient, category, options.allMail);
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

  let trashedCount = 0;
  for (const message of candidates) {
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
      const mailto = parseMailtoUri(`mailto:${parsed.mailto.address}${parsed.mailto.subject ? `?subject=${encodeURIComponent(parsed.mailto.subject)}` : ""}`);
      if (mailto) {
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
