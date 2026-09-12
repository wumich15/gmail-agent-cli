import { HostedSessionError } from "../auth/hosted-session.js";
import type { HostedSession } from "../auth/hosted-session.js";
import type { HostedAiService } from "../auth/publisher-client.js";
import {
  HOSTED_CONTRACT_VERSION,
  HostedClassifyResponseSchema,
  HostedDraftResponseSchema,
  type HostedClassifyRequest,
  type HostedClassifyResponse,
  type HostedDraftRequest,
  type HostedDraftResponse
} from "./hosted-contract.js";

/**
 * The CLI's client for the publisher AI gateway.
 *
 * It speaks only the two typed operations in `hosted-contract.ts`. There is
 * deliberately no method here that takes a model name, a prompt, a tool list,
 * or an arbitrary path: whatever a modified client could reach through this
 * object is exactly what the gateway already validates and meters.
 *
 * Failure is always safe. Every error is classified into one of four kinds so
 * the caller can do the right thing without parsing a message: a `quota` or
 * `unavailable` result leaves the message for Review and the run continues on
 * rules alone, while `auth` and `contract` are terminal conditions that tell
 * the user exactly what to do. Nothing here can cause a mailbox mutation.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;

export type HostedAiErrorKind =
  /** The session is gone, revoked, or was never consented to. Re-run setup. */
  | "auth"
  /** The publisher's allowance for this user (or globally) is exhausted. */
  | "quota"
  /** This CLI's contract version is not served any more. Upgrade the package. */
  | "contract"
  /** Transient: network, timeout, provider outage, or the service being restarted. */
  | "unavailable";

export class HostedAiError extends Error {
  constructor(
    message: string,
    readonly kind: HostedAiErrorKind,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "HostedAiError";
  }
}

export class HostedAiClient {
  private readonly session: HostedSession;

  constructor(
    private readonly service: HostedAiService,
    session: HostedSession
  ) {
    this.session = session;
  }

  async classify(request: Omit<HostedClassifyRequest, "contractVersion">): Promise<HostedClassifyResponse> {
    const raw = await this.post("/v1/ai/classify", { contractVersion: HOSTED_CONTRACT_VERSION, ...request });
    const parsed = HostedClassifyResponseSchema.safeParse(raw);
    if (!parsed.success) {
      // The gateway validates its provider's structured output before
      // answering, so a shape we cannot parse means the two sides disagree
      // about the contract — not that the model produced something odd.
      throw new HostedAiError("The AI service returned an unexpected response shape.", "contract");
    }
    return parsed.data;
  }

  async draft(request: Omit<HostedDraftRequest, "contractVersion">): Promise<HostedDraftResponse> {
    const raw = await this.post("/v1/ai/draft", { contractVersion: HOSTED_CONTRACT_VERSION, ...request });
    const parsed = HostedDraftResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HostedAiError("The AI service returned an unexpected response shape.", "contract");
    }
    return parsed.data;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let lastError: HostedAiError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.postOnce(path, body);
      } catch (error) {
        const hosted =
          error instanceof HostedAiError
            ? error
            : error instanceof HostedSessionError
              ? new HostedAiError(error.message, error.needsReconsent ? "auth" : "unavailable")
              : new HostedAiError(error instanceof Error ? error.message : String(error), "unavailable");
        // Only a transient condition is worth another attempt. Re-sending a
        // request the service refused on authorization, contract, or budget
        // grounds cannot change the answer and only burns the user's time.
        if (hosted.kind !== "unavailable" || attempt === MAX_ATTEMPTS) throw hosted;
        lastError = hosted;
        const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
        // Full jitter: many messages are classified concurrently, and without
        // it a service blip would line every worker up to retry in lockstep.
        await sleep(Math.random() * delay);
      }
    }
    throw lastError ?? new HostedAiError("The AI service could not be reached.", "unavailable");
  }

  private async postOnce(path: string, body: unknown): Promise<unknown> {
    const idToken = await this.session.idToken();
    let response: Response;
    try {
      response = await fetch(`${this.service.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // A redirect from an authenticated POST would replay the bearer token
        // at whatever host the response names. The gateway never redirects.
        redirect: "error"
      });
    } catch (error) {
      throw new HostedAiError(
        error instanceof Error && error.name === "TimeoutError"
          ? "The AI service did not respond in time."
          : `Could not reach the AI service: ${error instanceof Error ? error.message : String(error)}`,
        "unavailable"
      );
    }

    if (response.ok) {
      return (await response.json()) as unknown;
    }

    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    // Only the service's own short, allowlisted `error` string is ever
    // surfaced or logged. A raw upstream body can contain request IDs,
    // prompts, or tokens.
    const detail = await shortErrorText(response);
    if (response.status === 401 || response.status === 403) {
      throw new HostedAiError(
        `The AI service did not accept this session (${detail}). Run \`gmail setup\` to reconnect it.`,
        "auth"
      );
    }
    if (response.status === 402 || response.status === 429) {
      throw new HostedAiError(
        `The included AI allowance is used up for now (${detail}). This run continues with rules only.`,
        "quota",
        retryAfter
      );
    }
    if (response.status === 409 || response.status === 426) {
      throw new HostedAiError(
        `This version of the CLI is no longer supported by the AI service (${detail}). Upgrade with \`npm install --global gmail-agent-cli\`.`,
        "contract"
      );
    }
    if (response.status === 400 || response.status === 413 || response.status === 422) {
      // A rejected request body is this client's fault, not a transient
      // condition; retrying an identical body would only repeat it.
      throw new HostedAiError(`The AI service rejected the request (${detail}).`, "contract");
    }
    throw new HostedAiError(`The AI service is unavailable (${detail}).`, "unavailable", retryAfter);
  }
}

async function shortErrorText(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: unknown };
    if (typeof parsed?.error === "string" && parsed.error.length <= 200) return parsed.error;
  } catch {
    // Falls through to the status code, which is always safe to print.
  }
  return `HTTP ${response.status}`;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3_600);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.min(3_600, Math.round((date - Date.now()) / 1000)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
