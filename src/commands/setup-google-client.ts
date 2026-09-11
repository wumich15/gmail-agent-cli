import * as p from "@clack/prompts";
import pc from "picocolors";
import { validateOAuthClientInput, writeStoredOAuthClient } from "../auth/oauth-client-file.js";

/**
 * One-time registration of the user's own Google app.
 *
 * This tool ships no shared OAuth client on purpose: a shared one would put
 * whoever registered it in the path of everyone else's mailbox and quota.
 * The cost of that decision is this five-minute setup, so the instructions
 * live here rather than only in the documentation, and both `gmail setup`
 * and the browser page use this same copy.
 */
export const GOOGLE_CLIENT_STEPS = [
  "Open https://console.cloud.google.com/projectcreate and create a project (any name).",
  "In that project, enable the Gmail API and the Google Calendar API.",
  "Open the OAuth consent screen: choose External, fill in a name and your own email,",
  "  add your own Gmail address under Test users, and add these two scopes:",
  "    https://www.googleapis.com/auth/gmail.modify",
  "    https://www.googleapis.com/auth/calendar.events.owned",
  "Open Clients, create an OAuth client, and choose application type: Desktop app.",
  "Copy the client ID and client secret it shows you."
];

/** Returns true when a client was saved, false when the user backed out. */
export async function promptForGoogleClient(): Promise<boolean> {
  p.log.message(
    `${pc.bold("Connect this app to your own Google project")}\n\n` +
      "This tool has no server and no shared account, so it signs in through a Google app that you own.\n" +
      "Your mail is then only ever reachable with your own credentials, on this computer.\n\n" +
      GOOGLE_CLIENT_STEPS.map((step) => (step.startsWith(" ") ? step : `  • ${step}`)).join("\n")
  );

  const clientId = await p.text({
    message: "Client ID",
    placeholder: "1234567890-abc.apps.googleusercontent.com"
  });
  if (p.isCancel(clientId)) return false;
  // Typed rather than echoed back. A desktop client secret is not a password
  // (Google publishes this for the native-app flow), but there is no reason
  // to leave it in scrollback either.
  const clientSecret = await p.password({ message: "Client secret" });
  if (p.isCancel(clientSecret)) return false;

  const problem = validateOAuthClientInput(clientId, clientSecret);
  if (problem) {
    p.log.error(problem);
    return false;
  }

  const path = writeStoredOAuthClient({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
  p.log.success(`Saved to ${path} (readable only by your user account).`);
  return true;
}
