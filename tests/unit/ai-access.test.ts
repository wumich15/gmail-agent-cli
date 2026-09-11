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
    expect(AI_ACCESS_OPTIONS.map((option) => option.id)).toEqual(["managed", "api-key", "off"]);
    for (const option of AI_ACCESS_OPTIONS) {
      expect(option.requirements.length).toBeGreaterThan(20);
      expect(option.summary.length).toBeGreaterThan(20);
    }
  });

  it("offers a working option that needs no API key, which is the whole point", () => {
    const noKeyOptions = AI_ACCESS_OPTIONS.filter((option) => !option.needsApiKey && option.id !== "off");
    expect(noKeyOptions.map((option) => option.id)).toEqual(["managed"]);
    expect(noKeyOptions[0]?.sendsMailOffDevice).toBe(true);
  });
});

describe("applyAiAccessChoice", () => {
  let configPath: string;

  beforeEach(() => {
    // Written to a temp file, never the real per-user config.
    configPath = join(mkdtempSync(join(tmpdir(), "gmail-agent-config-")), "config.json");
  });

  it("uses included GPT with a Google identity token and no user OpenAI key", async () => {
    const prior = process.env["GMAIL_AGENT_AI_GATEWAY_URL"];
    process.env["GMAIL_AGENT_AI_GATEWAY_URL"] = "https://ai.example.test";
    try {
      const store = memoryStore();
      const saved = await applyAiAccessChoice({
        config: defaultConfig("UTC"),
        choice: "managed",
        accountHash: "acct",
        credentialStore: store,
        configPath
      });
      expect(saved.aiProvider).toBe("managed");
      expect(await store.getSecret("ai-api-key:acct")).toBeNull();

      const credentials = await resolveAiCredentials({
        accountHash: "acct",
        credentialStore: store,
        config: saved,
        managedIdentityToken: async () => "google-id-token",
        managedGatewayBaseURL: "https://ai.example.test/v1"
      });
      expect(credentials).toMatchObject({
        provider: "managed",
        apiKey: "google-id-token",
        baseURL: "https://ai.example.test/v1"
      });
    } finally {
      if (prior === undefined) delete process.env["GMAIL_AGENT_AI_GATEWAY_URL"];
      else process.env["GMAIL_AGENT_AI_GATEWAY_URL"] = prior;
    }
  });

  it("switching from a compatible endpoint back to OpenAI drops the custom base URL", async () => {
    const store = memoryStore();
    const compatible = parseConfig({
      ...defaultConfig("UTC"),
      aiEnabled: true,
      aiProvider: "openai-compatible",
      aiBaseUrl: "https://models.example.test/v1"
    });
    const hosted = await applyAiAccessChoice({
      config: compatible,
      choice: "api-key",
      apiKey: "sk-test",
      accountHash: "acct",
      credentialStore: store,
      configPath
    });
    expect(hosted.aiProvider).toBe("openai");
    expect(hosted.aiBaseUrl).toBeUndefined();
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
  it("upgrades a v1 file to the current schema recording what it was actually doing, and rewrites it", () => {
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

  it("moves a schema-v2 Ollama choice to Included GPT and removes incompatible local settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-agent-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: 2,
      timezone: "UTC",
      aiEnabled: true,
      aiProvider: "ollama",
      aiBaseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      composeModel: "llama3.2"
    }));

    const loaded = loadConfig(path);
    expect(loaded).toMatchObject({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      aiEnabled: true,
      aiProvider: "managed",
      model: DEFAULT_MODEL,
      composeModel: DEFAULT_COMPOSE_MODEL
    });
    expect(loaded?.aiBaseUrl).toBeUndefined();
  });
});
