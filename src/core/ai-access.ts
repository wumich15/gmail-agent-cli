import { saveConfig } from "../config/load.js";
import { CREDENTIAL_KEYS, type CredentialStore } from "../auth/credential-store.js";
import {
  DEFAULT_COMPOSE_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  type Config
} from "../config/schema.js";
import { ollamaListModels, OllamaError } from "../ai/ollama.js";

/**
 * How this install gets AI, as a user-facing choice.
 *
 * The product requirement is that real classification and drafting must be
 * reachable without the user creating, pasting, or managing an API key —
 * and that whatever each option actually costs them (money, hardware, or
 * capability) is visible *before* they choose it, never discovered later.
 * That is why every option carries its own cost/requirement text rather
 * than leaving it to whichever screen happens to render the list.
 */
export type AiAccessId = "local" | "api-key" | "off";

export interface AiAccessOption {
  id: AiAccessId;
  title: string;
  /** What actually happens to the user's mail under this option. */
  summary: string;
  /** Cost, hardware, and account requirements. Always shown before the choice is made. */
  requirements: string;
  /** True when mail text is sent to a third party, which requires explicit consent. */
  sendsMailOffDevice: boolean;
  needsApiKey: boolean;
}

export const AI_ACCESS_OPTIONS: readonly AiAccessOption[] = [
  {
    id: "local",
    title: "Local model on this computer (no API key)",
    summary:
      "Mail is classified and drafts are written by a model running on this machine through Ollama. " +
      "No message text leaves the computer and there is no account to create.",
    requirements:
      "Requires Ollama installed and running (ollama.com), plus one pulled model — roughly 2-5 GB of disk " +
      "and several GB of RAM. No money and no sign-up. Slower than a hosted model, and quality depends on " +
      "the model you pull; uncertain mail is routed to Review rather than acted on.",
    sendsMailOffDevice: false,
    needsApiKey: false
  },
  {
    id: "api-key",
    title: "Your own OpenAI API key (advanced)",
    summary:
      "Selected message text — never attachments — is sent to the OpenAI API to classify mail and draft " +
      "replies you review before sending.",
    requirements:
      "Requires an OpenAI account and API key that you create and pay for per use. The provider's standard " +
      "abuse-monitoring retention can still apply even though this app disables storage on every call.",
    sendsMailOffDevice: true,
    needsApiKey: true
  },
  {
    id: "off",
    title: "No AI — rules only",
    summary:
      "No message text is sent anywhere and no model runs. Native Gmail spam, your own spam/important " +
      "rules, and archiving of read mail still work; nothing else is classified.",
    requirements: "Nothing to install and nothing to pay. Anything needing judgment is left alone for you to handle.",
    sendsMailOffDevice: false,
    needsApiKey: false
  }
] as const;

export function aiAccessOption(id: AiAccessId): AiAccessOption {
  const found = AI_ACCESS_OPTIONS.find((option) => option.id === id);
  if (!found) throw new Error(`Unknown AI access option: ${id}`);
  return found;
}

/** Which option a stored config represents, for reporting current state. */
export function currentAiAccess(config: Config | null): AiAccessId {
  if (!config || !config.aiEnabled) return "off";
  return config.aiProvider === "ollama" ? "local" : "api-key";
}

export interface ApplyAiAccessInput {
  config: Config;
  choice: AiAccessId;
  /** Required for "api-key"; stored in the OS credential store, never in config or logs. */
  apiKey?: string | null;
  accountHash: string;
  credentialStore: CredentialStore;
  /** Override for a non-default local runtime address. */
  localBaseUrl?: string | undefined;
  localModel?: string | undefined;
  /** Overridable for tests; defaults to the real per-user config path. */
  configPath?: string | undefined;
}

/**
 * Applies an AI access choice: writes the non-secret parts to config.json
 * and any key to the OS credential store. Returns the saved config so the
 * caller can refresh the process-wide context (`core/bootstrap.ts`'s
 * `reloadConfig`) instead of continuing with a stale snapshot.
 */
export async function applyAiAccessChoice(input: ApplyAiAccessInput): Promise<Config> {
  let next: Config;
  if (input.choice === "off") {
    next = { ...input.config, aiEnabled: false };
  } else if (input.choice === "local") {
    next = {
      ...input.config,
      aiEnabled: true,
      aiProvider: "ollama",
      aiBaseUrl: input.localBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
      model: input.localModel ?? DEFAULT_LOCAL_MODEL,
      composeModel: input.localModel ?? DEFAULT_LOCAL_MODEL
    };
  } else {
    if (input.apiKey) {
      await input.credentialStore.setSecret(CREDENTIAL_KEYS.aiApiKey(input.accountHash), input.apiKey);
    }
    // Drop any local base URL left over from a previous choice; leaving it
    // in place would point the OpenAI client at a runtime that does not
    // implement the Responses API.
    const rest = { ...input.config };
    delete rest.aiBaseUrl;
    next = {
      ...rest,
      aiEnabled: true,
      aiProvider: "openai",
      model: input.config.model === DEFAULT_LOCAL_MODEL ? DEFAULT_MODEL : input.config.model,
      composeModel: input.config.composeModel === DEFAULT_LOCAL_MODEL ? DEFAULT_COMPOSE_MODEL : input.config.composeModel
    };
  }
  saveConfig(next, input.configPath);
  return next;
}

export interface LocalRuntimeStatus {
  reachable: boolean;
  baseUrl: string;
  models: string[];
  /** Present when the runtime could not be reached, in words a user can act on. */
  problem?: string;
}

/**
 * Checks whether the local runtime is actually usable *before* the user
 * commits to it, so "no API key needed" does not turn into a run that
 * silently classifies nothing. Never throws.
 */
export async function checkLocalRuntime(baseUrl = DEFAULT_OLLAMA_BASE_URL): Promise<LocalRuntimeStatus> {
  try {
    const models = await ollamaListModels(baseUrl);
    return { reachable: true, baseUrl, models };
  } catch (error) {
    return {
      reachable: false,
      baseUrl,
      models: [],
      problem:
        error instanceof OllamaError
          ? error.message
          : `Could not reach a local model runtime at ${baseUrl}.`
    };
  }
}
