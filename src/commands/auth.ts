import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { AccountsRepository } from "../state/repositories/accounts.js";
import { CREDENTIAL_KEYS } from "../auth/credential-store.js";
import { connectGoogleAccount } from "../core/connect.js";
import { chooseAiAccessInteractively } from "./setup-ai.js";
import { disconnectAccount } from "../core/onboarding.js";
import { EXIT_CODES } from "../core/errors.js";
import { ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";

export async function authLogin(): Promise<number> {
  const ctx = bootstrap();
  p.intro("Sign in to Google");

  p.log.message(
    "Automatic changes this app can make on your account: move spam, promotions, and low-value mail\n" +
      "to Trash (never permanently delete), star and label important mail, archive read Inbox mail,\n" +
      "and create Calendar events from actionable mail. It never adds Calendar attendees, sends\n" +
      "invitations, or creates Meet links.\n\n" +
      "Sending mail is never automatic. `gmail view` and `gmail send` can reply to a message or\n" +
      "compose a new one — including with an AI-written draft — but every outbound message, and\n" +
      "every unsubscribe request, stops at a screen showing the exact recipient, subject, and body\n" +
      "and is sent only if you confirm it there. The answer defaults to no, and no flag skips it.\n\n" +
      "If you choose a hosted AI provider, selected email text (never attachments) is sent to it to\n" +
      "help decide what is spam or important and to draft replies you review. That provider's\n" +
      "standard abuse-monitoring retention may still apply even with storage disabled on the call.\n" +
      "Choosing the local-model option instead keeps every message on this computer."
  );

  const proceed = await p.confirm({ message: "Continue and sign in with Google in your browser?" });
  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Login cancelled. No changes were made.");
    return EXIT_CODES.safetyBlocked;
  }

  const spinner = p.spinner();
  spinner.start("Waiting for browser sign-in");
  let authorizeUrl: string | null = null;
  try {
    // All of the actual work — OAuth, profile lookup, single-account
    // enforcement, credential and config writes — lives in
    // `core/connect.ts` so the browser setup view performs the identical
    // operation instead of a parallel implementation. This function only
    // asks the questions and prints the result.
    const result = await connectGoogleAccount(ctx, {
      onAuthorizeUrl: (url) => {
        authorizeUrl = url;
      },
      resolveTimezone: async (detected) => {
        spinner.stop("Signed in.");
        const answer = await p.text({
          message: "Confirm your IANA timezone",
          initialValue: detected,
          placeholder: detected
        });
        return p.isCancel(answer) ? detected : answer;
      }
    });

    await chooseAiAccessInteractively(ctx, result.accountHash);

    // Report what Google actually granted, not merely what was requested —
    // a Workspace admin policy can restrict a scope (most plausibly
    // Calendar) even when the consent screen showed it, and silently
    // claiming it was granted means the first real failure the user sees
    // is an unexplained Calendar API error much later, with no link back
    // to the actual cause.
    p.outro(
      `Signed in as ${result.emailDisplay}.\n` +
        `Granted scopes: ${result.grantedScopes.length > 0 ? result.grantedScopes.join(", ") : "(none reported by Google)"}\n` +
        (result.missingScopes.length > 0
          ? pc.yellow(
              `Warning: Google did not report granting: ${result.missingScopes.join(", ")}. Related features (e.g. Calendar) will fail until this is resolved.\n`
            )
          : "") +
        "Signing in changed nothing in your mailbox. Run 'gmail --dry-run' to preview what it would do."
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
    console.log(pc.yellow("Not configured. Run `gmail` first to sign in."));
    return EXIT_CODES.invalidOrAuthRequired;
  }

  // We don't persist which account is "current" beyond the accounts table;
  // for a single-account v1, report every account we know about.
  const rows = ctx.db.prepare("SELECT account_hash FROM accounts").all() as { account_hash: string }[];
  if (rows.length === 0) {
    console.log(pc.yellow("No account is signed in. Run `gmail` to sign in."));
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
    // Locked per-account: logout mutates credentials and account state
    // CLAUDE.md requires the lock for, and must not race a concurrent
    // gmail/gmail work run against this same account.
    const lock = new ProcessLock(lockFilePath(accountHash));
    lock.acquire();
    try {
      await logoutOneAccount(ctx, accountsRepo, accountHash);
    } finally {
      lock.release();
    }
  }

  console.log(pc.green("Signed out. Local credentials removed."));
  return EXIT_CODES.ok;
}

async function logoutOneAccount(
  ctx: ReturnType<typeof bootstrap>,
  accountsRepo: AccountsRepository,
  accountHash: string
): Promise<void> {
  const account = accountsRepo.get(accountHash);

  // Asked before anything is erased: removing local history is a separate
  // decision from disconnecting, and the user should not discover after
  // the fact that their rules and run log went with the credentials.
  const keepHistory = await p.confirm({
    message: `Keep local non-secret run/rule history for ${account?.emailDisplay ?? accountHash}?`,
    initialValue: true
  });
  const removeHistory = !p.isCancel(keepHistory) && !keepHistory;

  const result = await disconnectAccount(ctx, accountHash, { removeHistory });
  if (result.revokeProblem) {
    p.log.warn(
      `Local credentials were removed, but Google could not be told to drop the grant: ${result.revokeProblem}\n` +
        "You can revoke it yourself at https://myaccount.google.com/permissions."
    );
  }
}
