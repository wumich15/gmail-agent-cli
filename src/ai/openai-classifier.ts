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
import { EmailFlagsSchema, type EmailFlags } from "./schema.js";
import {
  buildClassificationInput,
  buildDeterministicSummary,
  DEVELOPER_INSTRUCTIONS,
  FEW_SHOT_EXAMPLES,
  PROMPT_VERSION
} from "./prompt.js";
import type { ClassifyContext, Classifier } from "./classifier.js";
import type { AssessmentResult, AssessmentUnavailable, EmailAssessment, NormalizedMessage } from "../core/models.js";

export const SCHEMA_VERSION = "schema-v2";
const DEFAULT_TIMEOUT_MS = 20_000;

/** Clearly above/below the 0.90 policy thresholds — the flags themselves are the decision; these just satisfy the existing threshold-based policy engine. */
const HIGH_CONFIDENCE = 0.98;
const LOW_CONFIDENCE = 0;

export interface OpenAiClassifierOptions {
  /** Falls back to the OPENAI_API_KEY environment variable when omitted (the SDK's own default). */
  apiKey?: string;
  /** Set for an OpenAI-compatible self-hosted endpoint; omit for the standard OpenAI API. */
  baseURL?: string;
  model: string;
  timeoutMs?: number;
  /** Injectable for tests; constructed from the options above otherwise. */
  client?: OpenAI;
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

  constructor(options: OpenAiClassifierOptions) {
    this.client =
      options.client ??
      new OpenAI({
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {})
      });
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async assess(message: NormalizedMessage, _context: ClassifyContext): Promise<AssessmentResult> {
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
              instructions: DEVELOPER_INSTRUCTIONS,
              input: buildInputWithExamples(message),
              store: false,
              text: { format: zodTextFormat(EmailFlagsSchema, "email_flags") }
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
        assessment: mapFlagsToAssessment(response.output_parsed, message, this.model)
      };
    } catch (error) {
      return { ok: false, unavailable: mapErrorToUnavailable(error) };
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

/**
 * Deterministically maps the model's cheap boolean flags onto the richer
 * internal EmailAssessment shape core/policy.ts already knows how to
 * consume, at fixed confidence values that clearly clear or miss its
 * 0.90 thresholds — the flags *are* the decision; these numbers only
 * exist to satisfy a policy engine built around graded confidence.
 * `suspicious` maps to a kind policy.ts already treats as "no AI-derived
 * mutation, route to Review" regardless of the other flags, so a
 * contradictory combination (e.g. suspicious+important both true) is
 * still safe by construction.
 */
function mapFlagsToAssessment(flags: EmailFlags, message: NormalizedMessage, model: string): EmailAssessment {
  const kind = flags.suspicious ? "suspicious" : flags.spam ? "promotion" : "personal_routine";
  return {
    kind,
    confidence: flags.suspicious || flags.spam ? HIGH_CONFIDENCE : LOW_CONFIDENCE,
    importanceScore: flags.important ? HIGH_CONFIDENCE : LOW_CONFIDENCE,
    importanceConfidence: flags.important ? HIGH_CONFIDENCE : LOW_CONFIDENCE,
    summary: buildDeterministicSummary(message),
    reasonCodes: [],
    event: flags.hasEvent
      ? {
          intent: "create",
          confidence: HIGH_CONFIDENCE,
          title: flags.eventTitle,
          start: flags.eventStart,
          end: flags.eventEnd,
          allDay: flags.eventAllDay,
          timeZone: null,
          location: null,
          sourceEvidence: null
        }
      : {
          intent: "none",
          confidence: LOW_CONFIDENCE,
          title: null,
          start: null,
          end: null,
          allDay: false,
          timeZone: null,
          location: null,
          sourceEvidence: null
        },
    classifierVersion: `openai:${model}`,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION
  };
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

function mapErrorToUnavailable(error: unknown): AssessmentUnavailable {
  const detail = error instanceof Error ? error.message : String(error);

  if (error instanceof APIConnectionTimeoutError) {
    return { reason: "timeout", detail };
  }
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return {
      reason: "not_configured",
      detail: "The AI provider rejected the API key or denied access to this model."
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
