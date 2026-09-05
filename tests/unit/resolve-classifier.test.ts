import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveClassifier } from "../../src/ai/resolve-classifier.js";
import { InMemoryCredentialStore, CREDENTIAL_KEYS } from "../../src/auth/credential-store.js";
import { NotConfiguredClassifier } from "../../src/ai/not-configured-classifier.js";
import { OpenAiClassifier } from "../../src/ai/openai-classifier.js";
import { defaultConfig, DEFAULT_MODEL } from "../../src/config/schema.js";

const ACCOUNT_HASH = "acct1";
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env["OPENAI_API_KEY"];
  delete process.env["GMAIL_AGENT_MODEL"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveClassifier", () => {
  it("falls back to NotConfiguredClassifier when no API key is found anywhere", async () => {
    const result = await resolveClassifier({
      accountHash: ACCOUNT_HASH,
      credentialStore: new InMemoryCredentialStore(),
      config: null
    });
    expect(result.classifier).toBeInstanceOf(NotConfiguredClassifier);
  });

  it("uses the OPENAI_API_KEY environment variable when no credential-store key exists", async () => {
    process.env["OPENAI_API_KEY"] = "sk-from-env";
    const result = await resolveClassifier({
      accountHash: ACCOUNT_HASH,
      credentialStore: new InMemoryCredentialStore(),
      config: null
    });
    expect(result.classifier).toBeInstanceOf(OpenAiClassifier);
  });

  it("prefers a credential-store key over the environment variable", async () => {
    process.env["OPENAI_API_KEY"] = "sk-from-env";
    const store = new InMemoryCredentialStore();
    await store.setSecret(CREDENTIAL_KEYS.aiApiKey(ACCOUNT_HASH), "sk-from-store");
    const result = await resolveClassifier({ accountHash: ACCOUNT_HASH, credentialStore: store, config: null });
    expect(result.classifier).toBeInstanceOf(OpenAiClassifier);
  });

  it("uses the persisted config's model when GMAIL_AGENT_MODEL is not set", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    const config = { ...defaultConfig("UTC"), model: "gpt-5.6-terra" };
    const result = await resolveClassifier({
      accountHash: ACCOUNT_HASH,
      credentialStore: new InMemoryCredentialStore(),
      config
    });
    expect(result.description).toContain("gpt-5.6-terra");
  });

  it("GMAIL_AGENT_MODEL overrides a stale model already persisted in config.json", async () => {
    // Regression: a config file written before a default-model change
    // would otherwise keep using the old model forever, since nothing
    // else ever rewrites it, and the docs promise this env var overrides.
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["GMAIL_AGENT_MODEL"] = "gpt-5.4-mini";
    const config = { ...defaultConfig("UTC"), model: "gpt-5.6-terra" };
    const result = await resolveClassifier({
      accountHash: ACCOUNT_HASH,
      credentialStore: new InMemoryCredentialStore(),
      config
    });
    expect(result.description).toContain("gpt-5.4-mini");
    expect(result.description).not.toContain("gpt-5.6-terra");
  });

  it("falls back to DEFAULT_MODEL when there is no config and no env override", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    const result = await resolveClassifier({
      accountHash: ACCOUNT_HASH,
      credentialStore: new InMemoryCredentialStore(),
      config: null
    });
    expect(result.description).toContain(DEFAULT_MODEL);
  });
});
