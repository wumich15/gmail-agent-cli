import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError
} from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { withApiRetry } from "../core/api-retry.js";
import { EmailFlagsSchema } from "./schema.js";
import { mapFlagsToAssessment, SCHEMA_VERSION } from "./assessment-mapping.js";
import { buildClassificationInput, buildDeveloperInstructions, FEW_SHOT_EXAMPLES } from "./prompt.js";
import type { ClassifyContext, Classifier } from "./classifier.js";
import type { AssessmentResult, AssessmentUnavailable, NormalizedMessage } from "../core/models.js";

// Re-exported for the many call sites (and the cache-version tuple) that
// have always imported it from here; it now lives beside the mapping it
// versions, which the local and hosted classifiers share.
export { SCHEMA_VERSION };

const DEFAULT_TIMEOUT_MS = 20_000;

export interface OpenAiClassifierOptions {
  /** Falls back to the OPENAI_API_KEY environment variable when omitted (the SDK's own default). */
  apiKey?: string;
  /** Set for an OpenAI-compatible self-hosted endpoint; omit for the standard OpenAI API. */
  baseURL?: string;
  model: string;
  timeoutMs?: number;
  /** Injectable for tests; constructed from the options above otherwise. */
  client?: OpenAI;
  /** Distinguishes publisher-gateway assessments from direct OpenAI ones in the cache. */
  assessmentProvider?: "openai" | "managed";
}

/**
 * Real Classifier implementation: one stateless Responses API call per
 * message, Structured Outputs parsed through a minimal boolean-flags Zod
 * schema (see ai/schema.ts for why), no tools, no store, no
 * previous_response_id. A few labeled examples are sent as real prior
 * turns before the actual message to improve accuracy at near-zero
 * marginal cost (identical prefix every call). See CLAUDE.md's "AI
 * assessment contract" for the underlying requirements.
 */
export class OpenAiClassifier implements Classifier {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly assessmentProvider: "openai" | "managed";

  constructor(options: OpenAiClassifierOptions) {
    this.client =
      options.client ??
      new OpenAI({
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
        // The SDK's own default retry (maxRetries: 2) would otherwise stack
        // with withApiRetry's outer retry loop below — up to 3x as many
        // real HTTP attempts, each on its own independently-scheduled
        // backoff, as the "3 attempts" this code documents and relies on
        // for a bounded worst-case latency per message.
        maxRetries: 0
      });
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.assessmentProvider = options.assessmentProvider ?? "openai";
  }

  async assess(message: NormalizedMessage, context: ClassifyContext): Promise<AssessmentResult> {
    try {
      // Retries transient 429/5xx from OpenAI with backoff, same as every
      // Gmail/Calendar call — lets a higher aiCalls concurrency actually
      // pay off instead of losing messages to rate-limit blips. Capped
      // lower/shorter than the Google default (3 attempts, 8s max delay):
      // this runs once per message, so a worst case of several full
      // backoff cycles here is directly felt as "the whole run is slow."
      const response = await withApiRetry(
        () =>
          this.client.responses.parse(
            {
              model: this.model,
              instructions: buildDeveloperInstructions(context.existingLabels ?? []),
              input: buildInputWithExamples(message),
              store: false,
              text: { format: zodTextFormat(EmailFlagsSchema, "email_flags") },
              // This is a small fixed-schema flag classification, not an
              // open-ended reasoning task — minimizing reasoning effort cuts
              // per-call latency substantially on reasoning-tier models
              // (the whole reason `gpt-5.4-mini` was chosen) without
              // affecting output shape, since Structured Outputs still
              // guarantees the schema regardless of effort level. Ignored
              // harmlessly by any model that doesn't support the field.
              reasoning: { effort: "low" }
            },
            { timeout: this.timeoutMs }
          ),
        { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 }
      );

      const refusal = extractRefusal(response);
      if (refusal !== null) {
        return { ok: false, unavailable: { reason: "refused", detail: refusal } };
      }
      if (!response.output_parsed) {
        return {
          ok: false,
          unavailable: {
            reason: "schema_failure",
            detail: "Model output did not match the required structured schema."
          }
        };
      }

      return {
        ok: true,
        assessment: mapFlagsToAssessment(response.output_parsed, message, `${this.assessmentProvider}:${this.model}`)
      };
    } catch (error) {
      return { ok: false, unavailable: mapErrorToUnavailable(error, this.assessmentProvider) };
    }
  }
}

/** Few-shot example turns (fixed prefix) followed by the real, untrusted message. */
function buildInputWithExamples(message: NormalizedMessage) {
  const exampleTurns = FEW_SHOT_EXAMPLES.flatMap((example) => [
    { role: "user" as const, content: example.input },
    { role: "assistant" as const, content: JSON.stringify(example.output) }
  ]);
  return [...exampleTurns, { role: "user" as const, content: buildClassificationInput(message) }];
}

function extractRefusal(response: { output?: readonly unknown[] }): string | null {
  for (const item of response.output ?? []) {
    if (typeof item !== "object" || item === null || !("content" in item)) {
      continue;
    }
    const content = (item as { content?: readonly unknown[] }).content ?? [];
    for (const part of content) {
      if (typeof part === "object" && part !== null && (part as { type?: string }).type === "refusal") {
        return (part as { refusal?: string }).refusal ?? "The model refused to assess this message.";
      }
    }
  }
  return null;
}

function mapErrorToUnavailable(
  error: unknown,
  provider: "openai" | "managed" = "openai"
): AssessmentUnavailable {
  const detail = error instanceof Error ? error.message : String(error);

  if (error instanceof APIConnectionTimeoutError) {
    return { reason: "timeout", detail };
  }
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return {
      reason: "not_configured",
      detail:
        provider === "managed"
          ? "The included AI service could not verify the Google sign-in. Reconnect Gmail and try again."
          : "The AI provider rejected the API key or denied access to this model."
    };
  }
  if (
    error instanceof RateLimitError ||
    error instanceof InternalServerError ||
    error instanceof APIConnectionError ||
    error instanceof APIError
  ) {
    return { reason: "provider_unavailable", detail };
  }
  return { reason: "schema_failure", detail };
}
