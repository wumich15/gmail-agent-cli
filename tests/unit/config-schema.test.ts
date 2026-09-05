import { describe, expect, it } from "vitest";
import { defaultConfig, parseConfig } from "../../src/config/schema.js";

describe("defaultConfig", () => {
  it("defaults to the openai provider with no base URL", () => {
    const config = defaultConfig("UTC");
    expect(config.aiProvider).toBe("openai");
    expect(config.aiBaseUrl).toBeUndefined();
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
