import { homedir } from "node:os";
import { join } from "node:path";

const APP_DIR_NAME = "gmail-agent-cli";

/** Per-OS app data directory. No network or filesystem access here. */
export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  }
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    return join(appData, APP_DIR_NAME);
  }
  const xdgConfigHome = env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(xdgConfigHome, APP_DIR_NAME);
}

export function configFilePath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return join(appDataDir(env, platform), "config.json");
}

export function databaseFilePath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return join(appDataDir(env, platform), "state.sqlite");
}

export function logDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return join(appDataDir(env, platform), "logs");
}

/**
 * Per-account lock file so two different signed-in accounts (a future
 * multi-account state) don't serialize behind one shared OS-user-wide
 * lock. Pass the account hash once it's known; omitting it is only for
 * call sites that genuinely predate account resolution.
 */
export function lockFilePath(
  accountHash?: string,
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform
): string {
  const fileName = accountHash ? `gmail-${accountHash.slice(0, 16)}.lock` : "gmail.lock";
  return join(appDataDir(env, platform), fileName);
}
