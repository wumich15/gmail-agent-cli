import { saveConfig } from "../config/load.js";
import { CREDENTIAL_KEYS, type CredentialStore } from "../auth/credential-store.js";
import type { Config } from "../config/schema.js";
import { resolveManagedAiGateway } from "../auth/publisher-client.js";
import { InvalidConfigError } from "./errors.js";

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
export type AiAccessId = "managed" | "api-key" | "off";

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
    id: "managed",
    title: "Included GPT (no API key)",
    summary:
      "Selected message text — never attachments — is sent through this app's publisher-operated AI service to OpenAI for classification and drafts.",
    requirements:
      "No OpenAI account, API key, or software installation is required. The publisher pays for usage and may enforce fair-use limits. " +
      "OpenAI's standard abuse-monitoring retention can still apply even though storage is disabled on every call.",
    sendsMailOffDevice: true,
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

/** Hides Included GPT in source/development builds that have no gateway configured. */
export function availableAiAccessOptions(): readonly AiAccessOption[] {
  return resolveManagedAiGateway()
    ? AI_ACCESS_OPTIONS
    : AI_ACCESS_OPTIONS.filter((option) => option.id !== "managed");
}

/** Which option a stored config represents, for reporting current state. */
export function currentAiAccess(config: Config | null): AiAccessId {
  if (!config || !config.aiEnabled) return "off";
  if (config.aiProvider === "managed") return "managed";
  return "api-key";
}

export interface ApplyAiAccessInput {
  config: Config;
  choice: AiAccessId;
  /** Required for "api-key"; stored in the OS credential store, never in config or logs. */
  apiKey?: string | null;
  accountHash: string;
  credentialStore: CredentialStore;
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
  } else if (input.choice === "managed") {
    if (!resolveManagedAiGateway()) {
      throw new InvalidConfigError(
        "This build does not include the publisher AI service. Use a release build or the advanced development API-key option."
      );
    }
    const rest = { ...input.config };
    delete rest.aiBaseUrl;
    next = {
      ...rest,
      aiEnabled: true,
      aiProvider: "managed",
      model: input.config.model,
      composeModel: input.config.composeModel
    };
  } else {
    if (input.apiKey) {
      await input.credentialStore.setSecret(CREDENTIAL_KEYS.aiApiKey(input.accountHash), input.apiKey);
    }
    // Drop a custom endpoint left over from a previous provider choice.
    const rest = { ...input.config };
    delete rest.aiBaseUrl;
    next = {
      ...rest,
      aiEnabled: true,
      aiProvider: "openai",
      model: input.config.model,
      composeModel: input.config.composeModel
    };
  }
  saveConfig(next, input.configPath);
  return next;
}
