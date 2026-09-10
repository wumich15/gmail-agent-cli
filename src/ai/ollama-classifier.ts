import { EmailFlagsSchema, EMAIL_FLAGS_JSON_SCHEMA } from "./schema.js";
import { mapFlagsToAssessment } from "./assessment-mapping.js";
import { buildClassificationInput, buildDeveloperInstructions, FEW_SHOT_EXAMPLES } from "./prompt.js";
import { ollamaChat, OllamaError } from "./ollama.js";
import type { OllamaMessage } from "./ollama.js";
import type { ClassifyContext, Classifier } from "./classifier.js";
import type { AssessmentResult, AssessmentUnavailable, NormalizedMessage } from "../core/models.js";

/**
 * The no-key classifier: the exact same prompt, wire schema, few-shot
 * turns, and deterministic flags-to-assessment mapping as the hosted
 * OpenAI classifier, run against a local Ollama model instead.
 *
 * It is a separate class rather than a base-URL option on `OpenAiClassifier`
 * because Ollama does not implement the Responses API — it takes a chat
 * message list and constrains generation with a JSON Schema in `format`
 * instead of Structured Outputs. The safety posture is identical and, if
 * anything, stronger: one stateless call per message, no tools, no stored
 * state, and no mail leaving the machine at all.
 *
 * Structured generation still guarantees shape, not truth, so the response
 * is re-validated through `EmailFlagsSchema` exactly like the hosted path.
 * Anything that fails validation becomes an unavailable assessment, which
 * policy treats as Review with no AI-derived mutation — the same safe
 * fallback as a hosted refusal or timeout.
 */
export class OllamaClassifier implements Classifier {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number | undefined;

  constructor(options: { baseUrl: string; model: string; timeoutMs?: number }) {
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
  }

  async assess(message: NormalizedMessage, context: ClassifyContext): Promise<AssessmentResult> {
    let raw: string;
    try {
      raw = await ollamaChat({
        baseUrl: this.baseUrl,
        model: this.model,
        messages: buildMessages(message, context),
        format: EMAIL_FLAGS_JSON_SCHEMA,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {})
      });
    } catch (error) {
      return { ok: false, unavailable: mapErrorToUnavailable(error) };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        unavailable: { reason: "schema_failure", detail: "The local model did not return valid JSON." }
      };
    }
    const flags = EmailFlagsSchema.safeParse(parsedJson);
    if (!flags.success) {
      return {
        ok: false,
        unavailable: {
          reason: "schema_failure",
          detail: "Local model output did not match the required structured schema."
        }
      };
    }

    return { ok: true, assessment: mapFlagsToAssessment(flags.data, message, `ollama:${this.model}`) };
  }
}

/**
 * Developer instructions as the system message, the same labeled examples
 * as real prior turns, then the one untrusted message. Mail content only
 * ever appears in a `user` turn — never in the system message — which is
 * the same isolation rule the hosted path follows.
 */
function buildMessages(message: NormalizedMessage, context: ClassifyContext): OllamaMessage[] {
  return [
    { role: "system", content: buildDeveloperInstructions(context.existingLabels ?? []) },
    ...FEW_SHOT_EXAMPLES.flatMap((example): OllamaMessage[] => [
      { role: "user", content: example.input },
      { role: "assistant", content: JSON.stringify(example.output) }
    ]),
    { role: "user", content: buildClassificationInput(message) }
  ];
}

function mapErrorToUnavailable(error: unknown): AssessmentUnavailable {
  if (error instanceof OllamaError) {
    if (error.kind === "timeout") return { reason: "timeout", detail: error.message };
    // A runtime that isn't running, or a model that was never pulled, is a
    // setup problem the user can fix — not a transient provider blip — so
    // it is reported as "not configured" rather than as an outage.
    if (error.kind === "model_missing" || error.kind === "unreachable") {
      return { reason: "not_configured", detail: error.message };
    }
    return { reason: "provider_unavailable", detail: error.message };
  }
  return { reason: "provider_unavailable", detail: error instanceof Error ? error.message : String(error) };
}
