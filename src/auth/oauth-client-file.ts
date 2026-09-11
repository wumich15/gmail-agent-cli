import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appDataDir } from "../config/paths.js";
import { InvalidConfigError } from "../core/errors.js";

/**
 * Where this install's Google OAuth *installed-app* client lives.
 *
 * This tool has no publisher and no server: each person registers their own
 * Desktop OAuth client in their own Google Cloud project, so their mail is
 * only ever reachable by their own credentials and their own API quota. The
 * alternative — shipping one shared client — would make whoever registered it
 * the data controller for everyone else's mailbox, which is exactly what this
 * design avoids.
 *
 * Storing the values means the user pastes them once instead of exporting two
 * environment variables in every terminal forever. A Desktop client secret is
 * not confidential (Google says so for the native-app flow, which is why this
 * flow also requires PKCE S256, a random `state`, and a loopback-only
 * redirect), but it is still written `0600` and kept out of the config file
 * and out of any log.
 */
const OAuthClientFileSchema = z
  .object({
    clientId: z.string().min(1).endsWith(".apps.googleusercontent.com"),
    clientSecret: z.string().min(1)
  })
  .strict();

export type StoredOAuthClient = z.infer<typeof OAuthClientFileSchema>;

export function oauthClientFilePath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return join(appDataDir(env, platform), "google-oauth-client.json");
}

/** Returns null when this machine has no saved client yet. */
export function readStoredOAuthClient(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform
): StoredOAuthClient | null {
  const path = oauthClientFilePath(env, platform);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if ((platform ?? process.platform) !== "win32") {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      throw new InvalidConfigError(
        `Refusing to read ${path}: permissions ${mode.toString(8)} make it readable by other accounts on this computer. ` +
          "Run `chmod 600` on it, or delete it and run `gmail setup` again."
      );
    }
  }
  const parsed = OAuthClientFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new InvalidConfigError(
      `${path} is not a valid saved Google OAuth client. Delete it and run \`gmail setup\` again.`
    );
  }
  return parsed.data;
}

export function writeStoredOAuthClient(
  client: StoredOAuthClient,
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform
): string {
  const validated = OAuthClientFileSchema.parse(client);
  const path = oauthClientFilePath(env, platform);
  mkdirSync(appDataDir(env, platform), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  if ((platform ?? process.platform) !== "win32") chmodSync(path, 0o600);
  return path;
}

export function deleteStoredOAuthClient(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): void {
  rmSync(oauthClientFilePath(env, platform), { force: true });
}

/** Shape check used by setup prompts before anything is written or sent to Google. */
export function validateOAuthClientInput(clientId: string, clientSecret: string): string | null {
  if (!clientId.trim().endsWith(".apps.googleusercontent.com")) {
    return "That does not look like a Google client ID — it should end in .apps.googleusercontent.com";
  }
  if (clientSecret.trim().length < 8) return "That does not look like a client secret.";
  return null;
}
