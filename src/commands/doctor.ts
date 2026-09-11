import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { CREDENTIAL_KEYS, CredentialStoreUnavailableError } from "../auth/credential-store.js";
import { resolveOAuthClientCredentials, oauthClientFromRefreshToken, OAUTH_SCOPES } from "../auth/google-oauth.js";
import { createGmailClient } from "../gmail/client.js";
import { fetchProfile } from "../gmail/scanner.js";
import { MIGRATIONS } from "../state/migrations/index.js";
import { EXIT_CODES } from "../core/errors.js";
import { DateTime } from "luxon";
import { getAiStatus, getConnectionStatus } from "../core/onboarding.js";

type CheckStatus = "ok" | "warn" | "fail";
interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Read-only diagnostics. Never modifies mail, Calendar, rules, or credentials. */
export async function runDoctor(): Promise<number> {
  const results: CheckResult[] = [];

  // Must match the `engines` floor in package.json; reporting "ok" on a
  // runtime the package refuses to install on is worse than no check.
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  const nodeSupported = (nodeMajor ?? 0) > 22 || ((nodeMajor ?? 0) === 22 && (nodeMinor ?? 0) >= 19);
  results.push({
    name: "Node.js runtime",
    status: nodeSupported ? "ok" : "fail",
    detail: `Node ${process.version} (>= 22.19 required)`
  });

  let ctx: ReturnType<typeof bootstrap> | null = null;
  try {
    ctx = bootstrap();
    const integrity = ctx.db.pragma("integrity_check") as { integrity_check: string }[];
    const ok = integrity.length === 1 && integrity[0]?.integrity_check === "ok";
    results.push({
      name: "Database integrity",
      status: ok ? "ok" : "fail",
      detail: ok ? "SQLite integrity_check passed" : JSON.stringify(integrity)
    });

    const appliedCount = (
      ctx.db.prepare("SELECT COUNT(*) as c FROM schema_migrations").get() as { c: number }
    ).c;
    results.push({
      name: "Schema migrations",
      status: appliedCount === MIGRATIONS.length ? "ok" : "warn",
      detail: `${appliedCount}/${MIGRATIONS.length} migrations applied`
    });
  } catch (error) {
    results.push({
      name: "Database",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    if (ctx) {
      const probeKey = "doctor-probe";
      await ctx.credentialStore.setSecret(probeKey, "probe");
      const readBack = await ctx.credentialStore.getSecret(probeKey);
      await ctx.credentialStore.deleteSecret(probeKey);
      results.push({
        name: "OS credential store",
        status: readBack === "probe" ? "ok" : "fail",
        detail: readBack === "probe" ? "round-trip succeeded" : "round-trip returned unexpected value"
      });
    }
  } catch (error) {
    results.push({
      name: "OS credential store",
      status: "fail",
      detail:
        error instanceof CredentialStoreUnavailableError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error)
    });
  }

  let oauthCredentials: { clientId: string; clientSecret: string } | null = null;
  try {
    oauthCredentials = resolveOAuthClientCredentials();
    results.push({ name: "OAuth client configuration", status: "ok", detail: "development client configured" });
  } catch (error) {
    results.push({
      name: "OAuth client configuration",
      status: "warn",
      detail: error instanceof Error ? error.message : String(error)
    });
  }

  if (ctx && oauthCredentials) {
    const accountsRepo = new AccountsRepository(ctx.db);
    const rows = ctx.db.prepare("SELECT account_hash FROM accounts").all() as { account_hash: string }[];
    if (rows.length === 0) {
      results.push({ name: "Google account", status: "warn", detail: "not signed in; run `gmail` to sign in" });
    }
    for (const { account_hash: accountHash } of rows) {
      const account = accountsRepo.get(accountHash);
      const refreshToken = await ctx.credentialStore.getSecret(CREDENTIAL_KEYS.oauthRefreshToken(accountHash));
      if (!refreshToken) {
        results.push({ name: `Google account ${account?.emailDisplay ?? accountHash}`, status: "fail", detail: "no refresh token stored" });
        continue;
      }
      try {
        const client = oauthClientFromRefreshToken(oauthCredentials, refreshToken);
        const gmailClient = createGmailClient(client);
        const profile = await fetchProfile(gmailClient);
        results.push({
          name: `Gmail API reachability (${profile.emailAddress})`,
          status: "ok",
          detail: `historyId ${profile.historyId}`
        });
        results.push({
          name: "OAuth scopes",
          status: "ok",
          detail: `requested: ${OAUTH_SCOPES.join(", ")}`
        });
      } catch (error) {
        results.push({
          name: `Gmail API reachability`,
          status: "fail",
          detail: error instanceof Error ? error.message : String(error)
        });
      }

      if (account) {
        const validTimezone = DateTime.local().setZone(account.timezone).isValid;
        results.push({
          name: "Timezone",
          status: validTimezone ? "ok" : "fail",
          detail: account.timezone
        });
      }
    }
  }

  if (ctx) {
    try {
      const connection = await getConnectionStatus(ctx);
      const ai = await getAiStatus(ctx, connection.accountHash);
      results.push({
        name: "AI classification",
        status: ai.ready ? "ok" : "warn",
        detail: ai.detail
      });
    } catch (error) {
      results.push({
        name: "AI classification",
        status: "warn",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  for (const result of results) {
    const icon = result.status === "ok" ? pc.green("✓") : result.status === "warn" ? pc.yellow("!") : pc.red("✗");
    console.log(`${icon} ${result.name}: ${result.detail}`);
  }

  const hasFailure = results.some((r) => r.status === "fail");
  return hasFailure ? EXIT_CODES.operationalFailure : EXIT_CODES.ok;
}
