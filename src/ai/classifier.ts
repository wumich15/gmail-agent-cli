import type { AssessmentResult, NormalizedMessage } from "../core/models.js";

export interface ClassifyContext {
  /** Cache key components; identical inputs across these must produce cached results. */
  classifierVersion: string;
  promptVersion: string;
  schemaVersion: string;
  policyVersion: string;
}

/**
 * The model is one untrusted analysis component. It receives no SDK
 * client, credentials, function tools, shell, network access, or prior
 * conversation state, and cannot directly mutate Gmail or Calendar — it
 * only returns a typed assessment that the deterministic policy consumes.
 */
export interface Classifier {
  assess(message: NormalizedMessage, context: ClassifyContext): Promise<AssessmentResult>;
}
