import { saveConfig } from "../config/load.js";
import { CREDENTIAL_KEYS, type CredentialStore } from "../auth/credential-store.js";
import type { Config } from "../config/schema.js";
import { HOSTED_AI_POLICY_VERSION, hostedOnboardingAvailable } from "../auth/publisher-client.js";
import { InvalidConfigError } from "./errors.js";

/**
 * How this install gets AI, as a user-facing choice.
 *
 * The requirement is that a normal user never has to create, paste, or pay
 * for an AI key — and that whatever each option actually costs them (money,
 * or a third party seeing message text) is visible *before* they choose it,
 * never discovered later. That is why every option carries its own cost and
 * data-transfer text rather than leaving it to whichever screen happens to
 * render the list.
 */
export type AiAccessId = "hosted" | "api-key" | "off";

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
    id: "hosted",
    title: "Included AI (nothing to set up)",
    summary:
      "During a preview or cleanup, each unresolved message may be classified automatically: its sender, subject, " +
      "date, your timezone, a bulk-mail signal, your Gmail label names, and bounded plain text — never attachments " +
      "and never your Gmail credentials — are sent through this app's publisher to an approved model service. " +
      "Drafting sends the message or the recipient/subject/purpose you chose.",
    requirements:
      "No AI account, API key, or payment. The publisher funds it and applies fair-use limits; when the allowance " +
      "runs out a run continues with rules only. Your data is used only for these features — never for training, " +
      "ranking, categorization, or any other secondary purpose. Recent Sent mail is never sampled to learn your " +
      "writing style under this option.",
    sendsMailOffDevice: true,
    needsApiKey: false
  },
  {
    id: "api-key",
    title: "Your own OpenAI API key (advanced)",
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
 * Hides the included-AI option in any build that could not actually connect it
 * — a source checkout, or a partially configured one — rather than offering a
 * choice that could only fail after the user had already accepted its
 * disclosure.
 */
export function availableAiAccessOptions(env: NodeJS.ProcessEnv = process.env): readonly AiAccessOption[] {
  return hostedOnboardingAvailable(env)
    ? AI_ACCESS_OPTIONS
    : AI_ACCESS_OPTIONS.filter((option) => option.id !== "hosted");
}

/** Which option a stored config represents, for reporting current state. */
export function currentAiAccess(config: Config | null): AiAccessId {
  if (!config || !config.aiEnabled) return "off";
  if (config.aiProvider === "hosted") return "hosted";
  return "api-key";
}

/**
 * True when the stored hosted consent is for an older disclosure than this
 * build publishes. Setup reopens the disclosure and records a fresh receipt
 * instead of carrying the old one forward — a data policy that changed in
 * substance is not something a user can be assumed to have already agreed to.
 */
export function hostedConsentIsStale(config: Config | null): boolean {
  if (!config || config.aiProvider !== "hosted") return false;
  return config.hostedAiConsent?.policyVersion !== HOSTED_AI_POLICY_VERSION;
}

export interface ApplyAiAccessInput {
  config: Config;
  choice: AiAccessId;
  /**
   * Set for "hosted": the moment the user affirmatively accepted the
   * disclosure. Recorded alongside the exact policy version so a later
   * version change is detectable locally.
   */
  consentedAt?: string;
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
  } else if (input.choice === "hosted") {
    if (!hostedOnboardingAvailable()) {
      throw new InvalidConfigError(
        "This build cannot connect the included AI service. Use a released build, or choose your own API key."
      );
    }
    const rest = { ...input.config };
    delete rest.aiBaseUrl;
    next = {
      ...rest,
      aiEnabled: true,
      aiProvider: "hosted",
      hostedAiConsent: {
        policyVersion: HOSTED_AI_POLICY_VERSION,
        acceptedAt: input.consentedAt ?? new Date().toISOString()
      }
    };
  } else {
    if (input.apiKey) {
      await input.credentialStore.setSecret(CREDENTIAL_KEYS.aiApiKey(input.accountHash), input.apiKey);
    }
    // Drop a custom endpoint, and any hosted consent receipt, left over from a
    // previous provider choice. A receipt that outlived the choice it was
    // taken for would misreport what this install is actually doing.
    const rest = { ...input.config };
    delete rest.aiBaseUrl;
    delete rest.hostedAiConsent;
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
