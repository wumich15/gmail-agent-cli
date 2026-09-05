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
import { EmailAssessmentSchema } from "./schema.js";
import { buildClassificationInput, DEVELOPER_INSTRUCTIONS, PROMPT_VERSION } from "./prompt.js";
import type { ClassifyContext, Classifier } from "./classifier.js";
import type { AssessmentResult, AssessmentUnavailable, NormalizedMessage } from "../core/models.js";

export const SCHEMA_VERSION = "schema-v1";
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
}

/**
 * Real Classifier implementation: one stateless Responses API call per
 * message, Structured Outputs parsed through the strict Zod schema, no
 * tools, no store, no previous_response_id. See CLAUDE.md's "AI
 * assessment contract" for the exact requirements this follows.
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
      const response = await this.client.responses.parse(
        {
          model: this.model,
          instructions: DEVELOPER_INSTRUCTIONS,
          input: buildClassificationInput(message),
          store: false,
          text: { format: zodTextFormat(EmailAssessmentSchema, "email_assessment") }
        },
        { timeout: this.timeoutMs }
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

      const parsed = response.output_parsed;
      return {
        ok: true,
        assessment: {
          kind: parsed.kind,
          confidence: parsed.confidence,
          importanceScore: parsed.importanceScore,
          importanceConfidence: parsed.importanceConfidence,
          summary: parsed.summary,
          reasonCodes: parsed.reasonCodes,
          event: parsed.event,
          classifierVersion: `openai:${this.model}`,
          promptVersion: PROMPT_VERSION,
          schemaVersion: SCHEMA_VERSION
        }
      };
    } catch (error) {
      return { ok: false, unavailable: mapErrorToUnavailable(error) };
    }
  }
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
