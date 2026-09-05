import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { CREDENTIAL_KEYS } from "../auth/credential-store.js";
import {
  loadDevOAuthClientCredentials,
  oauthClientFromRefreshToken,
  runInstalledAppLogin,
  OAUTH_SCOPES
} from "../auth/google-oauth.js";
import { createGmailClient } from "../gmail/client.js";
import { fetchProfile } from "../gmail/scanner.js";
import { accountHashFromEmail } from "../core/ids.js";
import { loadOrCreateDefaultConfig, saveConfig } from "../config/load.js";
import { EXIT_CODES } from "../core/errors.js";

export async function authLogin(): Promise<number> {
  const ctx = bootstrap();
  p.intro("gmail auth login");

  p.log.message(
    "This app can, on your account: move spam/promotions/low-value mail to Trash (never permanently\n" +
      "delete), star and label important mail, archive read Inbox mail, and create Calendar events\n" +
      "from actionable mail. It never sends replies, never adds Calendar attendees or Meet links, and\n" +
      "the only outbound email it can send is a confirmed unsubscribe request you approve.\n\n" +
      "If you enable AI classification, selected email text (not attachments) is sent to the\n" +
      "configured AI provider to help decide what's spam or important. That provider's standard\n" +
      "abuse-monitoring retention may still apply even with storage disabled on the API call."
  );

  const proceed = await p.confirm({ message: "Continue and sign in with Google in your browser?" });
  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Login cancelled. No changes were made.");
    return EXIT_CODES.safetyBlocked;
  }

  const credentials = loadDevOAuthClientCredentials();

  const spinner = p.spinner();
  spinner.start("Waiting for browser sign-in");
  let authorizeUrl: string | null = null;
  try {
    const result = await runInstalledAppLogin(credentials, (url) => {
      authorizeUrl = url;
    });
    spinner.stop("Signed in.");

    const oauthClient = oauthClientFromRefreshToken(credentials, result.refreshToken);
    const gmailClient = createGmailClient(oauthClient);
    const profile = await fetchProfile(gmailClient);
    const accountHash = accountHashFromEmail(profile.emailAddress);

    await ctx.credentialStore.setSecret(CREDENTIAL_KEYS.oauthRefreshToken(accountHash), result.refreshToken);

    const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezoneInput = await p.text({
      message: "Confirm your IANA timezone",
      initialValue: detectedTimezone,
      placeholder: detectedTimezone
    });
    const timezone = p.isCancel(timezoneInput) ? detectedTimezone : timezoneInput;

    const now = ctx.clock.nowIso();
    new AccountsRepository(ctx.db).upsert({
      accountHash,
      emailDisplay: profile.emailAddress,
      timezone,
      historyMarker: null,
      setupComplete: true,
      automationEnabled: false,
      createdAt: now,
      updatedAt: now
    });

    const config = loadOrCreateDefaultConfig(timezone);
    saveConfig({ ...config, timezone });

    p.outro(
      `Signed in as ${profile.emailAddress}.\n` +
        `Granted scopes: ${OAUTH_SCOPES.join(", ")}\n` +
        `Run 'gmail work --dry-run' to preview what this account would do.`
    );
    return EXIT_CODES.ok;
  } catch (error) {
    spinner.stop("Sign-in failed.");
    if (authorizeUrl) {
      p.log.info(`If the browser didn't open, visit:\n${authorizeUrl}`);
    }
    p.log.error(error instanceof Error ? error.message : String(error));
    return EXIT_CODES.invalidOrAuthRequired;
  }
}

export async function authStatus(): Promise<number> {
  const ctx = bootstrap();
  const accountsRepo = new AccountsRepository(ctx.db);

  if (!ctx.config) {
    console.log(pc.yellow("Not configured. Run `gmail auth login` first."));
    return EXIT_CODES.invalidOrAuthRequired;
  }

  // We don't persist which account is "current" beyond the accounts table;
  // for a single-account v1, report every account we know about.
  const rows = ctx.db.prepare("SELECT account_hash FROM accounts").all() as { account_hash: string }[];
  if (rows.length === 0) {
    console.log(pc.yellow("No account is signed in. Run `gmail auth login`."));
    return EXIT_CODES.invalidOrAuthRequired;
  }

  for (const { account_hash: accountHash } of rows) {
    const account = accountsRepo.get(accountHash);
    if (!account) continue;
    const hasSecret = (await ctx.credentialStore.getSecret(CREDENTIAL_KEYS.oauthRefreshToken(accountHash))) !== null;
    console.log(`${pc.bold(account.emailDisplay ?? "(email hidden)")}`);
    console.log(`  timezone: ${account.timezone}`);
    console.log(`  automation enabled: ${account.automationEnabled}`);
    console.log(`  refresh token stored: ${hasSecret ? pc.green("yes") : pc.red("no")}`);
  }
  return EXIT_CODES.ok;
}

export async function authLogout(): Promise<number> {
  const ctx = bootstrap();
  const accountsRepo = new AccountsRepository(ctx.db);
  const rows = ctx.db.prepare("SELECT account_hash FROM accounts").all() as { account_hash: string }[];

  if (rows.length === 0) {
    console.log(pc.yellow("No account is signed in."));
    return EXIT_CODES.ok;
  }

  for (const { account_hash: accountHash } of rows) {
    const account = accountsRepo.get(accountHash);
    const secretKey = CREDENTIAL_KEYS.oauthRefreshToken(accountHash);
    const refreshToken = await ctx.credentialStore.getSecret(secretKey);

    if (refreshToken) {
      try {
        const credentials = loadDevOAuthClientCredentials();
        const oauthClient = oauthClientFromRefreshToken(credentials, refreshToken);
        await oauthClient.revokeToken(refreshToken);
      } catch (error) {
        p.log.warn(`Could not revoke the Google grant remotely: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await ctx.credentialStore.deleteSecret(secretKey);

    const keepHistory = await p.confirm({
      message: `Keep local non-secret run/rule history for ${account?.emailDisplay ?? accountHash}?`,
      initialValue: true
    });
    if (!p.isCancel(keepHistory) && !keepHistory) {
      ctx.db.prepare("DELETE FROM accounts WHERE account_hash = ?").run(accountHash);
    }
  }

  console.log(pc.green("Signed out. Local credentials removed."));
  return EXIT_CODES.ok;
}
