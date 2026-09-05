import { CREDENTIAL_KEYS, type CredentialStore } from "../auth/credential-store.js";
import { DEFAULT_MODEL, type Config } from "../config/schema.js";
import { NotConfiguredClassifier } from "./not-configured-classifier.js";
import { OpenAiClassifier } from "./openai-classifier.js";
import type { Classifier } from "./classifier.js";

export interface ResolveClassifierInput {
  accountHash: string;
  credentialStore: CredentialStore;
  config: Config | null;
}

export interface ResolvedClassifier {
  classifier: Classifier;
  /** Human-readable, printed to the user so it's always clear which mode a run used. */
  description: string;
}

/**
 * Resolves which classifier a run should use. A usable API key — checked
 * in the OS credential store first, then the OPENAI_API_KEY environment
 * variable, matching how the OpenAI SDK itself defaults — is both
 * necessary and sufficient to enable real AI classification; this is the
 * practical opt-in signal for a local CLI tool with no separate consent
 * UI yet. Without one, NotConfiguredClassifier keeps the pipeline safe:
 * no AI-derived mutation, deterministic rules and read-archiving only.
 */
export async function resolveClassifier(input: ResolveClassifierInput): Promise<ResolvedClassifier> {
  const storedKey = await input.credentialStore.getSecret(CREDENTIAL_KEYS.aiApiKey(input.accountHash));
  const apiKey = storedKey ?? process.env["OPENAI_API_KEY"];

  if (!apiKey) {
    return {
      classifier: new NotConfiguredClassifier(),
      description: "AI classification is not configured (no API key found) — using rules-only mode."
    };
  }

  // GMAIL_AGENT_MODEL is documented as a live override (CLAUDE.md's
  // "Firm technology decisions" table), so it must win over whatever
  // model got persisted into config.json at an earlier sign-in — a
  // config file happily keeps a stale model name forever otherwise,
  // since nothing else ever rewrites it.
  const model = process.env["GMAIL_AGENT_MODEL"] || input.config?.model || DEFAULT_MODEL;
  const baseURL =
    input.config?.aiProvider === "openai-compatible" && input.config.aiBaseUrl ? input.config.aiBaseUrl : null;

  return {
    classifier: new OpenAiClassifier({
      apiKey,
      model,
      ...(baseURL !== null ? { baseURL } : {})
    }),
    description: `Using AI classification via ${baseURL ?? "the OpenAI API"} (model: ${model}).`
  };
}
