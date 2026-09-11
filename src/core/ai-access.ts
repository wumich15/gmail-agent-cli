import { saveConfig } from "../config/load.js";
import { CREDENTIAL_KEYS, type CredentialStore } from "../auth/credential-store.js";
import type { Config } from "../config/schema.js";

/**
 * How this install gets AI, as a user-facing choice.
 *
 * Everything runs on the user's own computer with the user's own provider
 * account, so the real requirement is that whatever each option costs them
 * — money, or capability — is visible *before* they choose it, never
 * discovered later. That is why every option carries its own cost text
 * rather than leaving it to whichever screen happens to render the list.
 */
export type AiAccessId = "api-key" | "off";

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
    id: "api-key",
    title: "Your own OpenAI API key",
    summary:
      "Selected message text — never attachments — is sent from this computer straight to the OpenAI API, " +
      "under your own account, to classify mail and draft replies you review before sending.",
    requirements:
      "Requires an OpenAI account and an API key you create at platform.openai.com. You pay OpenAI per use; " +
      "triage costs a fraction of a cent per message. The key is stored in your OS credential store and is " +
      "sent to nobody but OpenAI. The provider's standard abuse-monitoring retention can still apply even " +
      "though this app disables storage on every call.",
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

/**
 * Every option is always available: this tool talks to OpenAI directly with
 * the user's own key, or to nothing at all, so there is no build variant in
 * which one of them is missing.
 */
export function availableAiAccessOptions(): readonly AiAccessOption[] {
  return AI_ACCESS_OPTIONS;
}

/** Which option a stored config represents, for reporting current state. */
export function currentAiAccess(config: Config | null): AiAccessId {
  if (!config || !config.aiEnabled) return "off";
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
