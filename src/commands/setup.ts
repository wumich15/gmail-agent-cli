import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrap, reloadConfig } from "../core/bootstrap.js";
import { connectGoogleAccount } from "../core/connect.js";
import { disconnectAccount, getAiStatus, getConnectionStatus } from "../core/onboarding.js";
import { hostedConsentIsStale } from "../core/ai-access.js";
import { chooseAiAccessInteractively } from "./setup-ai.js";
import { promptForGoogleClient } from "./setup-google-client.js";
import { EXIT_CODES } from "../core/errors.js";

/**
 * The terminal counterpart of the browser Setup view. Both drive the same
 * operations in `core/onboarding.ts`, `core/connect.ts`, and
 * `core/ai-access.ts`; this file only asks and prints.
 *
 * Setup never reads or changes mail. Connecting an account is not allowed
 * to start a cleanup run, so this command ends by telling the user how to
 * preview one rather than doing it for them.
 */
export async function runSetup(): Promise<number> {
  const ctx = bootstrap();
  p.intro("Gmail agent setup");

  let connection = await getConnectionStatus(ctx);

  if (connection.oauthClientSource === "none") {
    // A released build embeds the publisher's Google app, so this only
    // happens in a source checkout or a build whose release configuration was
    // stripped. Ask for a client here rather than failing with instructions
    // the user has to go act on.
    if (!(await promptForGoogleClient())) {
      p.outro("No Google app saved yet, so there is nothing to sign in with. See docs/setup.md, then run `gmail setup` again.");
      return EXIT_CODES.invalidOrAuthRequired;
    }
    connection = await getConnectionStatus(ctx);
  }

  p.log.message(
    connection.connected
      ? `Connected as ${pc.bold(connection.emailDisplay ?? "(unknown address)")} (timezone ${connection.timezone}).`
      : "No Gmail account is connected yet."
  );
  p.log.message(
    "Google permissions this app asks for:\n\n" +
      connection.scopes.map((entry) => `${pc.bold(entry.scope)}\n  ${entry.why}`).join("\n\n")
  );

  const ai = await getAiStatus(ctx, connection.accountHash);
  p.log.message(`AI: ${ai.detail}`);
  if (hostedConsentIsStale(ctx.config)) {
    // A substantively changed data policy is not something the earlier
    // acceptance covers, so say so before offering any other action.
    p.log.warn(
      "The included AI service's data disclosure has changed since you accepted it. Choose \"Change how AI works\" " +
        "to read the current one; until then, runs use rules only."
    );
  }

  const action = await p.select({
    message: "What would you like to do?",
    options: [
      ...(connection.connected
        ? [
            { value: "ai", label: "Change how AI works" },
            { value: "reconnect", label: "Reconnect Gmail (sign in again)" },
            { value: "disconnect", label: "Disconnect Gmail from this computer" }
          ]
        : [{ value: "connect", label: "Connect Gmail" }]),
      { value: "google-client", label: "Replace the Google app this computer signs in with" },
      { value: "done", label: "Done" }
    ]
  });
  if (p.isCancel(action) || action === "done") {
    p.outro("Nothing changed.");
    return EXIT_CODES.ok;
  }

  if (action === "connect" || action === "reconnect") {
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
          const answer = await p.text({ message: "Confirm your IANA timezone", initialValue: detected, placeholder: detected });
          return p.isCancel(answer) ? detected : answer;
        }
      });
      if (result.missingScopes.length > 0) {
        p.log.warn(
          `Google did not report granting: ${result.missingScopes.join(", ")}.\n` +
            "Related features (most likely Calendar) will fail until that is resolved."
        );
      }
      reloadConfig(ctx);
      if (result.hostedAiProblem) {
        p.log.warn(
          `Gmail is connected, but the included AI service could not be enabled: ${result.hostedAiProblem}\n` +
            "This computer will use rules only. Run `gmail setup` again to retry, or choose your own API key."
        );
      } else if (result.aiMode === "hosted-ai") {
        p.log.success("Included AI is on. Your Sent mail is never sampled under this option.");
      } else if (result.aiMode === "rules-only") {
        p.log.info(
          "Connected without hosted AI: no message text leaves this computer. You can turn AI on later from " +
            "`gmail setup`, with your own API key or the included service."
        );
      } else {
        // No hosted disclosure page was part of this sign-in (a source build,
        // or a user's own Cloud project), so the choice has not been made yet.
        await chooseAiAccessInteractively(ctx, result.accountHash);
      }
      p.outro(
        `Connected as ${result.emailDisplay}. Nothing in your mailbox was touched.\n` +
          "Run 'gmail --dry-run' to preview a cleanup before applying one."
      );
      return EXIT_CODES.ok;
    } catch (error) {
      spinner.stop("Sign-in failed.");
      if (authorizeUrl) p.log.info(`If the browser didn't open, visit:\n${authorizeUrl}`);
      p.log.error(error instanceof Error ? error.message : String(error));
      return EXIT_CODES.invalidOrAuthRequired;
    }
  }

  if (action === "google-client") {
    const saved = await promptForGoogleClient();
    p.outro(saved ? "Saved. Connect Gmail to sign in with it." : "Nothing changed.");
    return EXIT_CODES.ok;
  }

  if (action === "ai") {
    await chooseAiAccessInteractively(ctx, connection.accountHash ?? "");
    reloadConfig(ctx);
    p.outro("Saved.");
    return EXIT_CODES.ok;
  }

  // Disconnect.
  const confirmed = await p.confirm({
    message: `Disconnect ${connection.emailDisplay ?? "this account"} and remove its credentials from this computer?`,
    initialValue: false
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.outro("Nothing changed.");
    return EXIT_CODES.ok;
  }
  const keepHistory = await p.confirm({ message: "Keep local non-secret run/rule history?", initialValue: true });
  const result = await disconnectAccount(ctx, connection.accountHash!, {
    removeHistory: !p.isCancel(keepHistory) && !keepHistory
  });
  if (result.revokeProblem) {
    p.log.warn(
      `Local credentials were removed, but Google could not be told to drop the grant: ${result.revokeProblem}\n` +
        "You can revoke it yourself at https://myaccount.google.com/permissions."
    );
  }
  if (result.hostedRevokeProblem) {
    p.log.warn(
      `The included AI session was removed from this computer, but the service could not be told to drop it: ` +
        `${result.hostedRevokeProblem}`
    );
  }
  p.outro("Disconnected.");
  return EXIT_CODES.ok;
}
