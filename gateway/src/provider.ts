import { EmailFlagsSchema, EMAIL_TAGS, type EmailFlags } from "../../src/ai/schema.js";
import type { ProviderConfig } from "./config.js";

/**
 * The only place in this service that talks to a model provider.
 *
 * Everything about the request is built here, from typed facts the caller
 * supplied: the instructions, the few-shot turns, the model, the schema, the
 * privacy routing, the token ceiling. Nothing a client sent can reach the
 * provider except as the content of a user turn. That is what stops this
 * service from being a subsidized general-purpose relay: there is no code
 * path by which a caller names a model, adds a tool, changes the
 * instructions, or reaches a different endpoint.
 *
 * `store: false` is set on every call, and the privacy-routing fields are
 * sent when the deployment requires them. Both are necessary and neither is
 * sufficient: the provider's own retention, abuse-monitoring, and secondary-use
 * terms are a contractual gate that has to pass before Gmail content is sent
 * here at all (see docs/launch/decisions.md).
 */

export type ProviderFailureReason = "refused" | "schema_failure" | "provider_unavailable" | "timeout";

export interface ProviderFailure {
  ok: false;
  reason: ProviderFailureReason;
  detail: string;
  /** True when the provider provably never accepted the request, so its quota reservation can be refunded. */
  rejectedOutright: boolean;
}

export interface ClassifySuccess {
  ok: true;
  flags: EmailFlags;
  modelVersion: string;
  totalTokens: number;
}

export interface DraftSuccess {
  ok: true;
  text: string;
  modelVersion: string;
  totalTokens: number;
}

/**
 * JSON Schema for the classification output, kept beside the Zod schema it
 * mirrors and validated against it after every call. Strict mode requires
 * every property to be listed in `required` and `additionalProperties: false`
 * on every object, so structured output can only ever produce this shape.
 * Shape is still not truth, which is why the Zod parse below is not
 * redundant: it is the boundary that rejects an out-of-range or wrong-typed
 * value that the provider's own validator let through.
 */
const EMAIL_FLAGS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tag: { type: "string", enum: [...EMAIL_TAGS] },
    eventTitle: { type: ["string", "null"] },
    eventStart: { type: ["string", "null"] },
    eventEnd: { type: ["string", "null"] },
    eventAllDay: { type: "boolean" },
    eventSourceEvidence: { type: ["string", "null"] },
    category: { type: ["string", "null"] }
  },
  required: ["tag", "eventTitle", "eventStart", "eventEnd", "eventAllDay", "eventSourceEvidence", "category"]
} as const;

interface ResponsesRequest {
  model: string;
  instructions: string;
  input: Array<{ role: "user" | "assistant"; content: string }>;
  store: false;
  max_output_tokens: number;
  text?: { format: { type: "json_schema"; name: string; strict: true; schema: unknown } };
  reasoning?: { effort: "low" };
  provider?: { data_collection?: "deny"; zdr?: boolean };
}

interface ResponsesResult {
  output_text?: string;
  model?: string;
  usage?: { total_tokens?: number };
  output?: Array<{ content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
}

async function callProvider(
  config: ProviderConfig,
  request: ResponsesRequest
): Promise<{ ok: true; result: ResponsesResult } | ProviderFailure> {
  const body: ResponsesRequest = {
    ...request,
    ...(config.requireZeroDataRetention || config.denyUpstreamDataCollection
      ? {
          provider: {
            ...(config.denyUpstreamDataCollection ? { data_collection: "deny" as const } : {}),
            ...(config.requireZeroDataRetention ? { zdr: true } : {})
          }
        }
      : {})
  };

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error"
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      reason: timedOut ? "timeout" : "provider_unavailable",
      // A timeout is ambiguous: the provider may have accepted and billed the
      // request. Only an outright rejection is refundable.
      detail: timedOut ? "The model service did not respond in time." : "The model service is unreachable.",
      rejectedOutright: false
    };
  }

  if (!response.ok) {
    // Deliberately not the provider's own body: it can carry request IDs, the
    // prompt that was rejected, or key material.
    const refundable = response.status === 400 || response.status === 401 || response.status === 429;
    return {
      ok: false,
      reason: "provider_unavailable",
      detail: `The model service returned ${response.status}.`,
      rejectedOutright: refundable
    };
  }

  return { ok: true, result: (await response.json()) as ResponsesResult };
}

function refusalText(result: ResponsesResult): string | null {
  for (const item of result.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "refusal") return part.refusal ?? "The model declined to answer.";
    }
  }
  return null;
}

function outputText(result: ResponsesResult): string {
  if (typeof result.output_text === "string" && result.output_text.length > 0) return result.output_text;
  const parts: string[] = [];
  for (const item of result.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("");
}

export async function classifyWithProvider(input: {
  config: ProviderConfig;
  instructions: string;
  turns: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<ClassifySuccess | ProviderFailure> {
  const outcome = await callProvider(input.config, {
    model: input.config.classifyModel,
    instructions: input.instructions,
    input: input.turns,
    store: false,
    max_output_tokens: input.config.maxOutputTokens,
    text: { format: { type: "json_schema", name: "email_flags", strict: true, schema: EMAIL_FLAGS_JSON_SCHEMA } },
    // A small fixed-schema classification, not an open-ended reasoning task.
    // Minimizing effort cuts per-call latency substantially on reasoning-tier
    // models without affecting output shape, which structured output
    // guarantees regardless of effort.
    reasoning: { effort: "low" }
  });
  if (!outcome.ok) return outcome;

  const refusal = refusalText(outcome.result);
  if (refusal !== null) {
    return { ok: false, reason: "refused", detail: refusal.slice(0, 500), rejectedOutright: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText(outcome.result));
  } catch {
    return {
      ok: false,
      reason: "schema_failure",
      detail: "The model returned output that was not valid JSON.",
      rejectedOutright: false
    };
  }
  const validated = EmailFlagsSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      reason: "schema_failure",
      detail: "The model returned output that did not match the required schema.",
      rejectedOutright: false
    };
  }

  return {
    ok: true,
    flags: validated.data,
    modelVersion: outcome.result.model ?? input.config.classifyModel,
    totalTokens: outcome.result.usage?.total_tokens ?? 0
  };
}

export async function draftWithProvider(input: {
  config: ProviderConfig;
  instructions: string;
  userTurn: string;
}): Promise<DraftSuccess | ProviderFailure> {
  const outcome = await callProvider(input.config, {
    model: input.config.draftModel,
    instructions: input.instructions,
    input: [{ role: "user", content: input.userTurn }],
    store: false,
    max_output_tokens: input.config.maxOutputTokens
  });
  if (!outcome.ok) return outcome;

  const refusal = refusalText(outcome.result);
  if (refusal !== null) {
    return { ok: false, reason: "refused", detail: refusal.slice(0, 500), rejectedOutright: false };
  }
  const text = outputText(outcome.result).trim();
  if (text.length === 0) {
    return {
      ok: false,
      reason: "schema_failure",
      detail: "The model returned an empty draft.",
      rejectedOutright: false
    };
  }
  return {
    ok: true,
    text,
    modelVersion: outcome.result.model ?? input.config.draftModel,
    totalTokens: outcome.result.usage?.total_tokens ?? 0
  };
}
