import { CREDENTIAL_KEYS, type CredentialStore } from "../auth/credential-store.js";
import { DEFAULT_COMPOSE_MODEL, DEFAULT_MODEL, type Config } from "../config/schema.js";
import { NotConfiguredClassifier } from "./not-configured-classifier.js";
import { OpenAiClassifier, SCHEMA_VERSION } from "./openai-classifier.js";
import { PROMPT_VERSION } from "./prompt.js";
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
  /**
   * The exact classifier/prompt/schema version identifiers this resolved
   * classifier would produce right now — passed straight through to
   * `core/orchestrator.ts`'s `OrchestratorDeps` so it can both label fresh
   * assessments correctly and recognize a still-valid cached one (see
   * `OrchestratorDeps.cachedAssessments`). All three are the fixed
   * `"not-configured"` placeholder for `NotConfiguredClassifier`, which
   * guarantees a cached row (always carrying a real `"openai:..."` version)
   * can never spuriously match it.
   */
  classifierVersion: string;
  promptVersion: string;
  schemaVersion: string;
}

export interface ResolvedOpenAiCredentials {
  apiKey: string;
  model: string;
  baseURL: string | null;
}

/**
 * Which job the model is being resolved for. These are deliberately
 * different models: `classify` runs a cheap call on every unresolved
 * message, while `compose` drafts prose the user will read, edit, and send
 * under their own name. See `config/schema.ts` for the two defaults.
 */
export type ModelPurpose = "classify" | "compose";

/**
 * Shared credential/model resolution: checked in the OS credential store
 * first, then the OPENAI_API_KEY environment variable, matching how the
 * OpenAI SDK itself defaults. Used both by `resolveClassifier` below and
 * by `gmail view`'s AI drafting, so the two never drift on which
 * key/provider they end up using — only the model differs, by `purpose`.
 */
export async function resolveOpenAiCredentials(
  input: ResolveClassifierInput,
  purpose: ModelPurpose = "classify"
): Promise<ResolvedOpenAiCredentials | null> {
  const storedKey = await input.credentialStore.getSecret(CREDENTIAL_KEYS.aiApiKey(input.accountHash));
  const apiKey = storedKey ?? process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    return null;
  }
  // GMAIL_AGENT_MODEL / GMAIL_AGENT_COMPOSE_MODEL are documented as live
  // overrides (CLAUDE.md's "Firm technology decisions" table), so they must
  // win over whatever model got persisted into config.json at an earlier
  // sign-in — a config file happily keeps a stale model name forever
  // otherwise, since nothing else ever rewrites it.
  const model =
    purpose === "compose"
      ? process.env["GMAIL_AGENT_COMPOSE_MODEL"] || input.config?.composeModel || DEFAULT_COMPOSE_MODEL
      : process.env["GMAIL_AGENT_MODEL"] || input.config?.model || DEFAULT_MODEL;
  const baseURL =
    input.config?.aiProvider === "openai-compatible" && input.config.aiBaseUrl ? input.config.aiBaseUrl : null;
  return { apiKey, model, baseURL };
}

/**
 * Resolves which classifier a run should use. A usable API key is both
 * necessary and sufficient to enable real AI classification; this is the
 * practical opt-in signal for a local CLI tool with no separate consent
 * UI yet. Without one, NotConfiguredClassifier keeps the pipeline safe:
 * no AI-derived mutation, deterministic rules and read-archiving only.
 */
export async function resolveClassifier(input: ResolveClassifierInput): Promise<ResolvedClassifier> {
  const credentials = await resolveOpenAiCredentials(input);

  if (!credentials) {
    return {
      classifier: new NotConfiguredClassifier(),
      description: "AI classification is not configured (no API key found) — using rules-only mode.",
      classifierVersion: "not-configured",
      promptVersion: "not-configured",
      schemaVersion: "not-configured"
    };
  }

  return {
    classifier: new OpenAiClassifier({
      apiKey: credentials.apiKey,
      model: credentials.model,
      ...(credentials.baseURL !== null ? { baseURL: credentials.baseURL } : {})
    }),
    description: `Using AI classification via ${credentials.baseURL ?? "the OpenAI API"} (model: ${credentials.model}).`,
    classifierVersion: `openai:${credentials.model}`,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION
  };
}
