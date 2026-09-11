import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPOSE_MODEL, DEFAULT_MODEL, defaultConfig, parseConfig } from "../../src/config/schema.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env["GMAIL_AGENT_AI_PROVIDER"];
  delete process.env["GMAIL_AGENT_AI_BASE_URL"];
  delete process.env["GMAIL_AGENT_AI_GATEWAY_URL"];
  delete process.env["OPENAI_API_KEY"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("defaultConfig", () => {
  it("defaults to the openai provider with no base URL", () => {
    const config = defaultConfig("UTC");
    expect(config.aiProvider).toBe("openai");
    expect(config.aiBaseUrl).toBeUndefined();
  });

  it("defaults a gateway-configured development build to the managed provider", () => {
    process.env["GMAIL_AGENT_AI_GATEWAY_URL"] = "https://ai.example.test";
    expect(defaultConfig("UTC").aiProvider).toBe("managed");
  });
});

describe("ConfigSchema", () => {
  it("accepts an openai-compatible provider with a base URL", () => {
    const config = parseConfig({
      schemaVersion: 1,
      timezone: "UTC",
      aiProvider: "openai-compatible",
      aiBaseUrl: "http://localhost:11434/v1"
    });
    expect(config.aiBaseUrl).toBe("http://localhost:11434/v1");
  });

  it("rejects an openai-compatible provider with no base URL", () => {
    expect(() =>
      parseConfig({
        schemaVersion: 1,
        timezone: "UTC",
        aiProvider: "openai-compatible"
      })
    ).toThrow();
  });

  it("rejects the removed local provider in current configs", () => {
    expect(() =>
      parseConfig({
        schemaVersion: 3,
        timezone: "UTC",
        aiProvider: "ollama"
      })
    ).toThrow();
  });

  it("fills in composeModel for a config file written before it existed", () => {
    // Real users' config.json predates the classify/compose model split and
    // is never rewritten, so the default has to apply on read or AI drafting
    // would silently fall back to the triage model.
    const config = parseConfig({ schemaVersion: 1, timezone: "UTC", model: "gpt-5.4-mini" });
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(config.composeModel).toBe(DEFAULT_COMPOSE_MODEL);
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      parseConfig({
        schemaVersion: 1,
        timezone: "UTC",
        notARealField: true
      })
    ).toThrow();
  });
});
