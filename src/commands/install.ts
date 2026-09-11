import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap, reloadConfig } from "../core/bootstrap.js";
import { connectGoogleAccount } from "../core/connect.js";
import { getAiStatus, getConnectionStatus, requestedScopes } from "../core/onboarding.js";
import { chooseAiAccessInteractively } from "./setup-ai.js";
import { promptForGoogleClient } from "./setup-google-client.js";
import { runWork } from "./work.js";
import { EXIT_CODES } from "../core/errors.js";
import { appDataDir } from "../config/paths.js";
import { openUrlInBrowser as openInBrowser } from "../core/open-browser.js";

/**
 * The guided first-run wizard.
 *
 * `gmail setup` is a menu for someone who already knows what they are doing.
 * This is the other audience: a person who just installed the tool and has
 * never created a Google Cloud project. It walks the whole path in order —
 * check the machine, register a Google app, sign in, choose how AI works,
 * preview a real run — and it can open each console page in the browser so
 * nobody has to copy a URL out of a terminal.
 *
 * Two properties matter more than the convenience. It is **resumable**: every
 * step detects what is already done and offers to keep it, so re-running
 * after a failure never undoes working configuration. And it **never cleans
 * up mail**: the last step is a dry run, because finishing setup must not be
 * what first changes someone's mailbox.
 */

const CONSOLE_URLS = {
  createProject: "https://console.cloud.google.com/projectcreate",
  gmailApi: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  calendarApi: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
  consentScreen: "https://console.cloud.google.com/apis/credentials/consent",
  credentials: "https://console.cloud.google.com/apis/credentials"
} as const;


/** Prints a URL and, unless the user declines, opens it. Returns false if they cancelled out. */
async function offerToOpen(label: string, url: string): Promise<boolean> {
  p.log.step(`${label}\n${pc.dim(url)}`);
  const open = await p.confirm({ message: "Open that page in your browser now?", initialValue: true });
  if (p.isCancel(open)) return false;
  if (open) openInBrowser(url);
  return true;
}

async function pause(message = "Press enter when that's done"): Promise<boolean> {
  const answer = await p.confirm({ message, initialValue: true });
  return !p.isCancel(answer);
}

/** Walks the Google Cloud console steps, then collects the Desktop client. */
async function registerGoogleApp(): Promise<boolean> {
  p.log.message(
    `${pc.bold("Step 1 of 4 — register a Google app of your own")}\n\n` +
      "Google won't let any program touch a mailbox until the program identifies itself.\n" +
      "This tool ships no shared identity on purpose: a shared one would route everyone's\n" +
      "mail and API quota through whoever registered it. So this app belongs to you.\n\n" +
      "It's free, it stays private to you, and it takes about five minutes."
  );

  if (!(await offerToOpen("Create a project — any name will do.", CONSOLE_URLS.createProject))) return false;
  if (!(await pause("Created the project (and selected it in the picker at the top)?"))) return false;

  if (!(await offerToOpen("Enable the Gmail API for that project.", CONSOLE_URLS.gmailApi))) return false;
  if (!(await pause("Gmail API enabled?"))) return false;

  if (!(await offerToOpen("Enable the Google Calendar API too.", CONSOLE_URLS.calendarApi))) return false;
  if (!(await pause("Calendar API enabled?"))) return false;

  p.log.message(
    `${pc.bold("Now the consent screen")} — this is what you'll see when you sign in.\n\n` +
      "  • User type: External\n" +
      "  • App name: anything you'll recognize; support and developer email: your own\n" +
      "  • Add yourself under Test users\n" +
      "  • Add exactly these two scopes:\n" +
      `      ${pc.cyan("https://www.googleapis.com/auth/gmail.modify")}\n` +
      `      ${pc.cyan("https://www.googleapis.com/auth/calendar.events.owned")}\n\n` +
      pc.dim(
        "While the app is in Testing, Google expires the sign-in every 7 days for Gmail\n" +
          "scopes. Pressing \"Publish app\" (and clicking past the one-time unverified-app\n" +
          "warning) makes it last. You're the only user either way."
      )
  );
  if (!(await offerToOpen("Configure the consent screen.", CONSOLE_URLS.consentScreen))) return false;
  if (!(await pause("Consent screen configured?"))) return false;

  p.log.message(
    `${pc.bold("Last console step")} — create the credential itself.\n\n` +
      "  Create credentials → OAuth client ID → Application type: " +
      pc.bold("Desktop app")
  );
  if (!(await offerToOpen("Create the OAuth client.", CONSOLE_URLS.credentials))) return false;

  return promptForGoogleClient();
}

export async function runInstall(): Promise<number> {
  // Every step of this is a question. Without a terminal there is nobody to
  // answer them, so say that plainly instead of failing inside a prompt.
  if (!process.stdin.isTTY) {
    console.error(
      pc.red(
        "gmail install is interactive and requires a terminal (stdin is not a TTY). " +
          "Run it directly in a terminal, or configure GMAIL_AGENT_OAUTH_CLIENT_ID, " +
          "GMAIL_AGENT_OAUTH_CLIENT_SECRET and OPENAI_API_KEY for an unattended setup."
      )
    );
    return EXIT_CODES.safetyBlocked;
  }
  const ctx = bootstrap();
  p.intro(pc.bold("Gmail agent — setup"));

  p.log.message(
    "This tool runs entirely on this computer. Nothing is relayed through a server,\n" +
      "and no account is created anywhere. Once set up, it can:\n\n" +
      "  • move bulk mail to Gmail's " + pc.bold("Trash") + " — never permanent deletion\n" +
      "  • star and mark important what looks like it needs you\n" +
      "  • add events to your own calendar from mail that names a real date\n" +
      "  • archive mail you've already read\n\n" +
      "It never sends an email without showing you the exact message first, and it\n" +
      "never follows instructions found inside an email."
  );

  const ready = await p.confirm({ message: "Set it up now?", initialValue: true });
  if (p.isCancel(ready) || !ready) {
    p.outro("Nothing was changed. Run `gmail install` whenever you're ready.");
    return EXIT_CODES.ok;
  }

  // Preflight: fail here, with a fixable message, rather than three steps
  // later inside an OAuth callback or a keychain write.
  const [major, minor] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 19)) {
    p.log.error(`Node.js ${process.versions.node} is too old. Install Node.js 22.19 or newer and run this again.`);
    return EXIT_CODES.invalidOrAuthRequired;
  }
  p.log.success(`Node.js ${process.versions.node} · state will live in ${appDataDir()}`);

  let connection = await getConnectionStatus(ctx);

  // ---- Step 1: the Google app -------------------------------------------
  if (connection.oauthClientSource === "none") {
    if (!(await registerGoogleApp())) {
      p.outro("Stopped before saving a Google app. Nothing was changed — run `gmail install` again to pick up here.");
      return EXIT_CODES.invalidOrAuthRequired;
    }
    connection = await getConnectionStatus(ctx);
  } else {
    p.log.success(
      connection.oauthClientSource === "environment"
        ? "Step 1 of 4 — using the Google app from your environment variables."
        : "Step 1 of 4 — this computer already has a Google app saved."
    );
    const replace = await p.confirm({ message: "Replace it with a different one?", initialValue: false });
    if (!p.isCancel(replace) && replace && !(await registerGoogleApp())) {
      p.outro("Kept the existing Google app. Nothing was changed.");
      return EXIT_CODES.ok;
    }
  }

  // ---- Step 2: sign in ---------------------------------------------------
  p.log.message(
    `${pc.bold("Step 2 of 4 — sign in to Gmail")}\n\n` +
      "Your browser will open Google's own consent screen. It asks for exactly two things:\n\n" +
      requestedScopes()
        .map((entry) => `  ${pc.cyan(entry.scope)}\n    ${entry.why}`)
        .join("\n\n") +
      "\n\n" +
      pc.dim("The sign-in is stored in your OS keychain, and you can revoke it any time at\nhttps://myaccount.google.com/permissions")
  );

  if (connection.connected) {
    p.log.success(`Already connected as ${pc.bold(connection.emailDisplay ?? "(unknown address)")}.`);
  } else {
    const go = await p.confirm({ message: "Open Google sign-in now?", initialValue: true });
    if (p.isCancel(go) || !go) {
      p.outro("Stopped before signing in. Your Google app is saved — run `gmail install` again to continue.");
      return EXIT_CODES.invalidOrAuthRequired;
    }
    const spinner = p.spinner();
    spinner.start("Waiting for browser sign-in");
    let authorizeUrl: string | null = null;
    try {
      const result = await connectGoogleAccount(ctx, {
        onAuthorizeUrl: (url) => {
          authorizeUrl = url;
        },
        resolveTimezone: async (detected) => {
          spinner.stop("Signed in.");
          const answer = await p.text({
            message: "Confirm your timezone (used for every date this tool reads or writes)",
            initialValue: detected,
            placeholder: detected
          });
          return p.isCancel(answer) ? detected : answer;
        }
      });
      if (result.missingScopes.length > 0) {
        p.log.warn(
          `Google did not grant: ${result.missingScopes.join(", ")}\n` +
            "Those features will not work until you reconnect with both scopes approved."
        );
      }
      p.log.success(`Connected as ${pc.bold(result.emailDisplay)} (timezone ${result.timezone}).`);
      reloadConfig(ctx);
      connection = await getConnectionStatus(ctx);
    } catch (error) {
      spinner.stop("Sign-in failed.");
      if (authorizeUrl) p.log.info(`If the browser didn't open, visit:\n${authorizeUrl}`);
      p.log.error(error instanceof Error ? error.message : String(error));
      p.outro("Your Google app is saved. Fix the problem above and run `gmail install` again.");
      return EXIT_CODES.invalidOrAuthRequired;
    }
  }

  // ---- Step 3: AI --------------------------------------------------------
  p.log.message(
    `${pc.bold("Step 3 of 4 — how much judgment do you want?")}\n\n` +
      "Rules-only already handles Gmail's own spam, your rules, and archiving read mail,\n" +
      "and sends nothing anywhere. An OpenAI key adds the judgment calls: which mail is\n" +
      "bulk, which needs you, and which describes a real appointment."
  );
  const ai = await getAiStatus(ctx, connection.accountHash);
  if (ai.ready) {
    p.log.success(ai.detail);
    const change = await p.confirm({ message: "Change how AI works?", initialValue: false });
    if (!p.isCancel(change) && change) {
      await chooseAiAccessInteractively(ctx, connection.accountHash ?? "");
      reloadConfig(ctx);
    }
  } else {
    await chooseAiAccessInteractively(ctx, connection.accountHash ?? "");
    reloadConfig(ctx);
  }

  // ---- Step 4: a dry run -------------------------------------------------
  p.log.message(
    `${pc.bold("Step 4 of 4 — look before anything changes")}\n\n` +
      "A dry run reads your mail and prints exactly what it would do. It changes\n" +
      "nothing in Gmail or Calendar."
  );
  const preview = await p.confirm({ message: "Run a preview over your 25 most recent messages?", initialValue: true });
  if (!p.isCancel(preview) && preview) {
    p.log.info("Reading mail…");
    // Finishing setup must never be what first changes a mailbox, so this is
    // hard-coded to a dry run rather than taking a flag.
    const code = await runWork({ dryRun: true, json: false, limit: 25 });
    if (code !== EXIT_CODES.ok) {
      p.log.warn("The preview reported a problem above. Setup itself is still complete.");
    }
  }

  p.note(
    [
      `${pc.bold("gmail --dry-run")}      preview a cleanup, change nothing`,
      `${pc.bold("gmail")}                run the cleanup for real`,
      `${pc.bold("gmail view")}           read, search, reply, and delete mail`,
      `${pc.bold("gmail setup")}          change the connection or AI later`,
      `${pc.bold("gmail help")}           every command and keystroke`
    ].join("\n"),
    "You're set up"
  );
  p.outro("Nothing in your mailbox has been changed yet.");
  return EXIT_CODES.ok;
}
