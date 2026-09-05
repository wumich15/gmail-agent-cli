import type { GmailAgentDatabase } from "../database.js";
import type { RuleAction, RuleGroup, RuleMatcher } from "../../core/models.js";

interface RuleGroupRow {
  id: string;
  account_hash: string;
  category_name: string;
  action: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RuleMatcherRow {
  rule_group_id: string;
  kind: string;
  normalized_value: string;
  auth_binding_mechanism: string | null;
  auth_binding_domain: string | null;
  provenance: string;
}

function matcherFromRow(row: RuleMatcherRow): RuleMatcher {
  return {
    kind: row.kind as RuleMatcher["kind"],
    normalizedValue: row.normalized_value,
    authBinding:
      row.auth_binding_mechanism && row.auth_binding_domain
        ? { mechanism: row.auth_binding_mechanism as "dkim" | "dmarc", domain: row.auth_binding_domain }
        : null
  };
}

export class RuleGroupsRepository {
  constructor(private readonly db: GmailAgentDatabase) {}

  listEnabled(accountHash: string): RuleGroup[] {
    return this.list(accountHash).filter((g) => g.enabled);
  }

  list(accountHash: string): RuleGroup[] {
    const groupRows = this.db
      .prepare("SELECT * FROM rule_groups WHERE account_hash = ? ORDER BY created_at")
      .all(accountHash) as RuleGroupRow[];

    return groupRows.map((row) => {
      const matcherRows = this.db
        .prepare("SELECT * FROM rule_matchers WHERE rule_group_id = ?")
        .all(row.id) as RuleMatcherRow[];
      return {
        id: row.id,
        accountHash: row.account_hash,
        categoryName: row.category_name,
        action: row.action as RuleAction,
        enabled: row.enabled === 1,
        matchers: matcherRows.map(matcherFromRow),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
  }

  get(id: string): RuleGroup | null {
    const row = this.db.prepare("SELECT * FROM rule_groups WHERE id = ?").get(id) as
      | RuleGroupRow
      | undefined;
    if (!row) return null;
    const matcherRows = this.db
      .prepare("SELECT * FROM rule_matchers WHERE rule_group_id = ?")
      .all(row.id) as RuleMatcherRow[];
    return {
      id: row.id,
      accountHash: row.account_hash,
      categoryName: row.category_name,
      action: row.action as RuleAction,
      enabled: row.enabled === 1,
      matchers: matcherRows.map(matcherFromRow),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  create(group: RuleGroup): void {
    const insertGroup = this.db.prepare(
      `INSERT INTO rule_groups (id, account_hash, category_name, action, enabled, created_at, updated_at)
       VALUES (@id, @accountHash, @categoryName, @action, @enabled, @createdAt, @updatedAt)`
    );
    const insertMatcher = this.db.prepare(
      `INSERT INTO rule_matchers (rule_group_id, kind, normalized_value, auth_binding_mechanism, auth_binding_domain, provenance)
       VALUES (@ruleGroupId, @kind, @normalizedValue, @authBindingMechanism, @authBindingDomain, @provenance)`
    );

    const transaction = this.db.transaction(() => {
      insertGroup.run({
        id: group.id,
        accountHash: group.accountHash,
        categoryName: group.categoryName,
        action: group.action,
        enabled: group.enabled ? 1 : 0,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt
      });
      for (const matcher of group.matchers) {
        insertMatcher.run({
          ruleGroupId: group.id,
          kind: matcher.kind,
          normalizedValue: matcher.normalizedValue,
          authBindingMechanism: matcher.authBinding?.mechanism ?? null,
          authBindingDomain: matcher.authBinding?.domain ?? null,
          provenance: "gmail-agent-cli"
        });
      }
    });
    transaction();
  }

  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM rule_groups WHERE id = ?").run(id);
    return result.changes > 0;
  }

  setEnabled(id: string, enabled: boolean, updatedAt: string): void {
    this.db
      .prepare("UPDATE rule_groups SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, updatedAt, id);
  }
}
