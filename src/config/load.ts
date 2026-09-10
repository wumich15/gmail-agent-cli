import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { configFilePath } from "./paths.js";
import { defaultConfig, migrateConfig, parseConfig, type Config } from "./schema.js";
import { InvalidConfigError } from "../core/errors.js";

export function loadConfig(path: string = configFilePath()): Config | null {
  if (!existsSync(path)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new InvalidConfigError(`Config file at ${path} is not valid JSON: ${String(error)}`);
  }
  let parsed: Config;
  try {
    parsed = parseConfig(raw);
  } catch (error) {
    throw new InvalidConfigError(`Config file at ${path} failed validation: ${String(error)}`);
  }
  // Upgrade in place so the meaning of a field never depends on which
  // version of the app happened to write the file (see `migrateConfig`).
  // A read-only filesystem must not make the app unusable, so a failed
  // write-back is tolerated: the migrated value is still returned and the
  // upgrade is simply retried on the next read.
  const migrated = migrateConfig(parsed);
  if (!migrated) {
    return parsed;
  }
  try {
    saveConfig(migrated, path);
  } catch {
    // Intentionally ignored; see above.
  }
  return migrated;
}

export function saveConfig(config: Config, path: string = configFilePath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
  }
}

export function loadOrCreateDefaultConfig(timezone: string, path?: string): Config {
  const existing = loadConfig(path);
  if (existing) {
    return existing;
  }
  const created = defaultConfig(timezone);
  saveConfig(created, path);
  return created;
}
