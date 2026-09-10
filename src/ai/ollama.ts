/**
 * Minimal, hardened client for a local Ollama runtime.
 *
 * This exists because Ollama is the no-key inference path (its local API
 * requires no authentication at all — https://docs.ollama.com/api/authentication),
 * and because pointing `aiBaseUrl` at it is *not* enough: Ollama does not
 * implement the OpenAI Responses API this app uses, so it needs a real
 * adapter. Only two endpoints are used, both on the user's own machine:
 * `POST /api/chat` for a single stateless completion, and `GET /api/tags`
 * to report which models are actually pulled.
 *
 * The same discipline the unsubscribe client applies to attacker-controlled
 * URLs applies here for a different reason: the *content* fed to this
 * runtime is untrusted mail. So every call is bounded (connect/total
 * timeout, response byte cap), nothing is streamed, no conversation state
 * is kept between calls, and no tool/function capability is ever offered to
 * the model.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Local inference is slower than a hosted API and returns one JSON object,
 * so the cap only needs to be generous enough for a bounded reply body. A
 * runaway generation is truncated and rejected rather than buffered.
 */
const MAX_RESPONSE_BYTES = 1_000_000;

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatRequest {
  baseUrl: string;
  model: string;
  messages: readonly OllamaMessage[];
  /** JSON Schema constraining generation. Omit for free-form text (drafting). */
  format?: unknown;
  timeoutMs?: number;
  /** Deterministic-ish triage; drafting passes a higher value. */
  temperature?: number;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "model_missing" | "timeout" | "bad_response"
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/chat`;
}

function tagsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/tags`;
}

/** One stateless, non-streaming completion. Returns the assistant message content. */
export async function ollamaChat(request: OllamaChatRequest): Promise<string> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(chatUrl(request.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: false,
        ...(request.format !== undefined ? { format: request.format } : {}),
        options: { temperature: request.temperature ?? 0 }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new OllamaError(
      timedOut
        ? `The local model did not respond within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not reach a local Ollama runtime at ${request.baseUrl}. Is \`ollama serve\` running?`,
      timedOut ? "timeout" : "unreachable"
    );
  }

  if (response.status === 404) {
    throw new OllamaError(
      `The local runtime has no model named "${request.model}". Run \`ollama pull ${request.model}\` first.`,
      "model_missing"
    );
  }
  if (!response.ok) {
    throw new OllamaError(`The local model returned HTTP ${response.status}.`, "bad_response");
  }

  const text = await readBounded(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OllamaError("The local model returned a response that was not JSON.", "bad_response");
  }
  const content = (parsed as { message?: { content?: unknown } }).message?.content;
  if (typeof content !== "string") {
    throw new OllamaError("The local model returned no message content.", "bad_response");
  }
  return content;
}

/** Model names currently pulled on this machine, for setup and `gmail doctor`. */
export async function ollamaListModels(baseUrl: string, timeoutMs = 5_000): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(tagsUrl(baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new OllamaError(
      `Could not reach a local Ollama runtime at ${baseUrl}. Is \`ollama serve\` running?`,
      "unreachable"
    );
  }
  if (!response.ok) {
    throw new OllamaError(`The local runtime returned HTTP ${response.status}.`, "bad_response");
  }
  const parsed = JSON.parse(await readBounded(response)) as { models?: Array<{ name?: unknown }> };
  return (parsed.models ?? []).map((model) => model.name).filter((name): name is string => typeof name === "string");
}

async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new OllamaError("The local model's response exceeded the size limit.", "bad_response");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
}
