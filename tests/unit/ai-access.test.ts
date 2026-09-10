import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_ACCESS_OPTIONS, applyAiAccessChoice, currentAiAccess } from "../../src/core/ai-access.js";
import { loadConfig } from "../../src/config/load.js";
import {
  defaultConfig,
  parseConfig,
  CURRENT_CONFIG_SCHEMA_VERSION,
  DEFAULT_COMPOSE_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_MODEL
} from "../../src/config/schema.js";
import { resolveAiCredentials } from "../../src/ai/resolve-classifier.js";
import type { CredentialStore } from "../../src/auth/credential-store.js";

function memoryStore(initial: Record<string, string> = {}): CredentialStore {
  const values = new Map(Object.entries(initial));
  return {
    getSecret: async (key: string) => values.get(key) ?? null,
    setSecret: async (key: string, value: string) => {
      values.set(key, value);
    },
    deleteSecret: async (key: string) => {
      values.delete(key);
    }
  } as CredentialStore;
}

describe("AI access options", () => {
  it("states cost, hardware, and data-sharing consequences for every option before it can be chosen", () => {
    expect(AI_ACCESS_OPTIONS.map((option) => option.id)).toEqual(["local", "api-key", "off"]);
    for (const option of AI_ACCESS_OPTIONS) {
      expect(option.requirements.length).toBeGreaterThan(20);
      expect(option.summary.length).toBeGreaterThan(20);
    }
  });

  it("offers a working option that needs no API key, which is the whole point", () => {
    const noKeyOptions = AI_ACCESS_OPTIONS.filter((option) => !option.needsApiKey && option.id !== "off");
    expect(noKeyOptions.length).toBeGreaterThan(0);
    expect(noKeyOptions.every((option) => !option.sendsMailOffDevice)).toBe(true);
  });
});

describe("applyAiAccessChoice", () => {
  let configPath: string;

  beforeEach(() => {
    // Written to a temp file, never the real per-user config.
    configPath = join(mkdtempSync(join(tmpdir(), "gmail-agent-config-")), "config.json");
  });

  it("turns the local runtime on without asking for or storing any key", async () => {
    const store = memoryStore();
    const saved = await applyAiAccessChoice({
      config: defaultConfig("UTC"),
      choice: "local",
      accountHash: "acct",
      credentialStore: store,
      configPath
    });
    expect(saved.aiEnabled).toBe(true);
    expect(saved.aiProvider).toBe("ollama");
    expect(saved.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(await store.getSecret("ai-api-key:acct")).toBeNull();

    const credentials = await resolveAiCredentials({ accountHash: "acct", credentialStore: store, config: saved });
    expect(credentials).not.toBeNull();
    expect(credentials!.provider).toBe("ollama");
    expect(credentials!.apiKey).toBeNull();
  });

  it("switching from local back to a key drops the local base URL and model", async () => {
    const store = memoryStore();
    const local = await applyAiAccessChoice({
      config: defaultConfig("UTC"),
      choice: "local",
      accountHash: "acct",
      credentialStore: store,
      configPath
    });
    const hosted = await applyAiAccessChoice({
      config: local,
      choice: "api-key",
      apiKey: "sk-test",
      accountHash: "acct",
      credentialStore: store,
      configPath
    });
    expect(hosted.aiProvider).toBe("openai");
    expect(hosted.aiBaseUrl).toBeUndefined();
    expect(hosted.model).not.toBe(DEFAULT_LOCAL_MODEL);
    expect(await store.getSecret("ai-api-key:acct")).toBe("sk-test");
  });

  it("off really is off: a usable key no longer enables classification", async () => {
    const store = memoryStore({ "ai-api-key:acct": "sk-test" });
    const config = await applyAiAccessChoice({
      config: defaultConfig("UTC"),
      choice: "off",
      accountHash: "acct",
      credentialStore: store,
      configPath
    });
    expect(currentAiAccess(config)).toBe("off");
    expect(await resolveAiCredentials({ accountHash: "acct", credentialStore: store, config })).toBeNull();
  });
});

describe("config schema migration", () => {
  it("upgrades a v1 file to v2 recording what it was actually doing, and rewrites it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-agent-config-"));
    const path = join(dir, "config.json");
    // Every v1 file on disk carries aiEnabled: false while a usable key
    // still activated AI, so reading the flag literally would silently
    // disable classification for existing installs.
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, timezone: "UTC", aiEnabled: false }));

    const loaded = loadConfig(path);
    expect(loaded?.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(loaded?.aiEnabled).toBe(true);
    expect(parseConfig(JSON.parse(readFileSync(path, "utf-8"))).schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
  });
});

describe("local model resolution", () => {
  it("ignores a hosted default left in config when the provider is local, but honors an explicit override", async () => {
    const store = memoryStore();
    const base = { schemaVersion: 2 as const, timezone: "UTC", aiEnabled: true, aiProvider: "ollama" as const };
    const stale = parseConfig({ ...base, model: DEFAULT_MODEL, composeModel: DEFAULT_COMPOSE_MODEL });

    // A config from before the switch names a model no local runtime has.
    const resolved = await resolveAiCredentials({ accountHash: "acct", credentialStore: store, config: stale });
    expect(resolved!.model).toBe(DEFAULT_LOCAL_MODEL);

    // Someone who names a model on purpose gets that model.
    const chosen = parseConfig({ ...base, model: "qwen3:8b", composeModel: "qwen3:8b" });
    const resolvedChosen = await resolveAiCredentials({ accountHash: "acct", credentialStore: store, config: chosen });
    expect(resolvedChosen!.model).toBe("qwen3:8b");
  });

  it("needs no key at all for the local provider, even with none stored anywhere", async () => {
    const config = parseConfig({
      schemaVersion: 2,
      timezone: "UTC",
      aiEnabled: true,
      aiProvider: "ollama",
      model: DEFAULT_LOCAL_MODEL,
      composeModel: DEFAULT_LOCAL_MODEL
    });
    const resolved = await resolveAiCredentials({ accountHash: "acct", credentialStore: memoryStore(), config });
    expect(resolved).not.toBeNull();
    expect(resolved!.apiKey).toBeNull();
    expect(resolved!.baseURL).toBe("http://127.0.0.1:11434");
  });
});
