import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount } from "./shared.js";
import { RuleGroupsRepository } from "../state/repositories/rule-groups.js";
import { EXIT_CODES } from "../core/errors.js";

export async function rulesList(options: { json: boolean }): Promise<number> {
  const ctx = bootstrap();
  const { account } = await resolveAccount(ctx);
  const groups = new RuleGroupsRepository(ctx.db).list(account.accountHash);

  if (options.json) {
    console.log(JSON.stringify(groups));
    return EXIT_CODES.ok;
  }

  if (groups.length === 0) {
    console.log("No rules yet. Create one with `gmail add spam <category>` or `gmail add important <category>`.");
    return EXIT_CODES.ok;
  }

  for (const group of groups) {
    console.log(`${pc.bold(group.categoryName)} [${group.id}] — ${group.action} — ${group.enabled ? "enabled" : "disabled"}`);
    for (const matcher of group.matchers) {
      console.log(`  ${matcher.kind}: ${matcher.normalizedValue}${matcher.authBinding ? ` (bound to ${matcher.authBinding.mechanism}:${matcher.authBinding.domain})` : ""}`);
    }
  }
  return EXIT_CODES.ok;
}

export async function rulesRemove(ruleGroupId: string): Promise<number> {
  const ctx = bootstrap();
  await resolveAccount(ctx);
  const removed = new RuleGroupsRepository(ctx.db).remove(ruleGroupId);
  if (!removed) {
    console.error(pc.red(`No rule group with ID ${ruleGroupId}.`));
    return EXIT_CODES.invalidOrAuthRequired;
  }
  console.log(pc.green(`Removed rule group ${ruleGroupId}.`));
  return EXIT_CODES.ok;
}
