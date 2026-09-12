import {
  HostedClassifyRequestSchema,
  HostedDraftRequestSchema,
  HostedSessionBootstrapRequestSchema,
  type HostedClassifyResponse,
  type HostedDraftResponse
} from "../../src/ai/hosted-contract.js";
import { buildDeveloperInstructions, FEW_SHOT_EXAMPLES, renderClassificationInput } from "../../src/ai/prompt.js";
import {
  buildNewEmailDraftInput,
  buildReplyDraftInput,
  DRAFT_DEVELOPER_INSTRUCTIONS
} from "../../src/ai/draft-prompt.js";
import { SERVED_CONTRACT_VERSION, type GatewayConfig } from "./config.js";
import {
  EntitlementError,
  mintSessionToken,
  recordConsent,
  requireCurrentEntitlement,
  revokeEntitlement
} from "./entitlements.js";
import { bearerToken, IdentityError, verifyFirebaseIdToken, verifyGoogleIdToken } from "./identity.js";
import { logRequest } from "./logging.js";
import { QuotaExceededError, recordTokens, releaseReservation, reserveRequest } from "./quota.js";
import { classifyWithProvider, draftWithProvider, type ProviderFailure } from "./provider.js";

/**
 * The gateway's whole surface: four typed operations and nothing else.
 *
 * Deliberately transport-agnostic (a request shape in, a response shape out)
 * so the same code runs behind a Firebase Function, behind Cloud Run, and in
 * a test with no network at all. There is no route that proxies, no route
 * that takes a model or a provider URL, no route that returns a credential,
 * and no route that touches Gmail.
 *
 * Order of checks on an AI request, and the reason for it:
 *
 *   1. kill switch      — an incident stops everything, before any work
 *   2. contract version — a client this deployment cannot serve is told so
 *   3. identity         — who is calling
 *   4. entitlement      — a current, non-revoked consent receipt
 *   5. schema           — reject unknown fields and oversized input
 *   6. quota            — reserve before spending the publisher's money
 *   7. provider         — the only outbound call, built entirely here
 *
 * Message text is parsed off the wire at step 5, which is after consent is
 * verified at step 4: content never reaches this process's own validation
 * layer on behalf of someone who has not consented.
 */

export interface GatewayRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface GatewayDeps {
  config: GatewayConfig;
  now: () => Date;
}

export async function handleGatewayRequest(request: GatewayRequest, deps: GatewayDeps): Promise<GatewayResponse> {
  const startedAt = Date.now();
  const path = request.path.replace(/\/+$/, "") || "/";

  if (request.method !== "POST") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }

  try {
    switch (path) {
      case "/v1/session/bootstrap":
        return await bootstrapSession(request, deps, startedAt);
      case "/v1/session/revoke":
        return await revokeSession(request, deps, startedAt);
      case "/v1/ai/classify":
        return await classify(request, deps, startedAt);
      case "/v1/ai/draft":
        return await draft(request, deps, startedAt);
      default:
        return { status: 404, body: { error: "not_found" } };
    }
  } catch (error) {
    // The catch-all never echoes the thrown value: an unexpected exception
    // here can carry a stack frame with request data in it.
    const mapped = mapError(error);
    logRequest({
      operation: operationFor(path),
      userId: null,
      status: mapped.status,
      durationMs: Date.now() - startedAt,
      outcome: mapped.outcome
    });
    return {
      status: mapped.status,
      body: { error: mapped.message },
      // A client that is told to come back later should be told when. The CLI
      // reads this and reports the wait instead of retrying into the same
      // wall.
      ...(error instanceof QuotaExceededError
        ? { headers: { "retry-after": String(error.retryAfterSeconds) } }
        : {})
    };
  }
}

async function bootstrapSession(
  request: GatewayRequest,
  deps: GatewayDeps,
  startedAt: number
): Promise<GatewayResponse> {
  const parsed = HostedSessionBootstrapRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return logged("session.bootstrap", null, 400, startedAt, "bad_request", { error: "invalid_request" });
  }
  const identity = await verifyGoogleIdToken(parsed.data.googleIdToken, deps.config);
  const entitlement = await recordConsent({
    userId: identity.pseudonymousId,
    policyVersion: parsed.data.policyVersion,
    config: deps.config,
    nowIso: deps.now().toISOString()
  });
  const customToken = await mintSessionToken(entitlement.userId);
  return logged("session.bootstrap", entitlement.userId, 200, startedAt, "ok", {
    customToken,
    allowance: deps.config.allowanceDescription
  });
}

async function revokeSession(
  request: GatewayRequest,
  deps: GatewayDeps,
  startedAt: number
): Promise<GatewayResponse> {
  const { userId } = await verifyFirebaseIdToken(bearerToken(request.headers["authorization"]));
  await revokeEntitlement(userId, deps.now().toISOString());
  return logged("session.revoke", userId, 200, startedAt, "ok", { revoked: true });
}

/** Shared preamble for both AI operations. Throws rather than returning on every failure path. */
async function authorizeAiRequest(
  request: GatewayRequest,
  deps: GatewayDeps
): Promise<{ userId: string }> {
  if (deps.config.killSwitch) {
    throw new EntitlementError("The included AI service is temporarily unavailable.", 503);
  }
  const contractVersion = (request.body as { contractVersion?: unknown } | null)?.contractVersion;
  if (contractVersion !== SERVED_CONTRACT_VERSION) {
    throw new EntitlementError(
      `This service speaks contract version ${SERVED_CONTRACT_VERSION}. Upgrade the CLI.`,
      409
    );
  }
  const { userId } = await verifyFirebaseIdToken(bearerToken(request.headers["authorization"]));
  await requireCurrentEntitlement(userId, deps.config);
  return { userId };
}

async function classify(request: GatewayRequest, deps: GatewayDeps, startedAt: number): Promise<GatewayResponse> {
  const { userId } = await authorizeAiRequest(request, deps);

  const parsed = HostedClassifyRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return logged("ai.classify", userId, 400, startedAt, "bad_request", { error: "invalid_request" });
  }

  await reserveRequest(userId, deps.config.quota, deps.now());

  // The provider request is assembled entirely here: the instructions, the
  // labeled example turns, and finally the caller's message rendered through
  // the same renderer the local classifier uses. The caller contributed
  // evidence, never instructions.
  const instructions = buildDeveloperInstructions(parsed.data.existingLabels);
  const turns = [
    ...FEW_SHOT_EXAMPLES.flatMap((example) => [
      { role: "user" as const, content: example.input },
      { role: "assistant" as const, content: JSON.stringify(example.output) }
    ]),
    { role: "user" as const, content: renderClassificationInput(parsed.data.message) }
  ];

  const outcome = await classifyWithProvider({ config: deps.config.provider, instructions, turns });
  if (!outcome.ok) {
    return await providerFailureResponse("ai.classify", userId, startedAt, outcome, deps);
  }
  await recordTokens(userId, outcome.totalTokens);

  const body: HostedClassifyResponse = {
    ok: true,
    flags: outcome.flags,
    modelVersion: outcome.modelVersion
  };
  return logged("ai.classify", userId, 200, startedAt, "ok", body, outcome.totalTokens);
}

async function draft(request: GatewayRequest, deps: GatewayDeps, startedAt: number): Promise<GatewayResponse> {
  const { userId } = await authorizeAiRequest(request, deps);

  const parsed = HostedDraftRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return logged("ai.draft", userId, 400, startedAt, "bad_request", { error: "invalid_request" });
  }

  await reserveRequest(userId, deps.config.quota, deps.now());

  const task = parsed.data.task;
  const userTurn =
    task.kind === "reply"
      ? buildReplyDraftInput({
          fromDisplayName: task.fromDisplayName,
          fromAddress: task.fromAddress,
          subject: task.subject,
          content: task.content,
          guidance: task.guidance,
          styleProfile: parsed.data.styleGuidance
        })
      : buildNewEmailDraftInput({
          to: task.to,
          subject: task.subject,
          purpose: task.purpose,
          styleProfile: parsed.data.styleGuidance
        });

  const outcome = await draftWithProvider({
    config: deps.config.provider,
    instructions: DRAFT_DEVELOPER_INSTRUCTIONS,
    userTurn
  });
  if (!outcome.ok) {
    return await providerFailureResponse("ai.draft", userId, startedAt, outcome, deps);
  }
  await recordTokens(userId, outcome.totalTokens);

  const body: HostedDraftResponse = { ok: true, text: outcome.text, modelVersion: outcome.modelVersion };
  return logged("ai.draft", userId, 200, startedAt, "ok", body, outcome.totalTokens);
}

/**
 * A provider failure is answered with HTTP 200 and a typed `ok: false`, not
 * an error status.
 *
 * That is deliberate: the CLI has to tell "the model could not assess this
 * message" (leave it for Review, keep going) apart from "you are not
 * authorized or out of allowance" (stop asking). Collapsing both into a 5xx
 * would make a single refused message look like a dead service.
 */
async function providerFailureResponse(
  operation: "ai.classify" | "ai.draft",
  userId: string,
  startedAt: number,
  failure: ProviderFailure,
  deps: GatewayDeps
): Promise<GatewayResponse> {
  if (failure.rejectedOutright) {
    await releaseReservation(userId, deps.now());
  }
  return logged(operation, userId, 200, startedAt, "provider_failed", {
    ok: false,
    reason: failure.reason,
    detail: failure.detail
  });
}

function operationFor(path: string): "session.bootstrap" | "session.revoke" | "ai.classify" | "ai.draft" {
  if (path.startsWith("/v1/ai/draft")) return "ai.draft";
  if (path.startsWith("/v1/session/revoke")) return "session.revoke";
  if (path.startsWith("/v1/session/bootstrap")) return "session.bootstrap";
  return "ai.classify";
}

function logged(
  operation: "session.bootstrap" | "session.revoke" | "ai.classify" | "ai.draft",
  userId: string | null,
  status: number,
  startedAt: number,
  outcome: Parameters<typeof logRequest>[0]["outcome"],
  body: unknown,
  totalTokens?: number
): GatewayResponse {
  logRequest({
    operation,
    userId,
    status,
    durationMs: Date.now() - startedAt,
    outcome,
    contractVersion: SERVED_CONTRACT_VERSION,
    ...(totalTokens !== undefined ? { totalTokens } : {})
  });
  return { status, body };
}

function mapError(error: unknown): {
  status: number;
  message: string;
  outcome: Parameters<typeof logRequest>[0]["outcome"];
} {
  if (error instanceof QuotaExceededError) {
    return { status: 429, message: error.message, outcome: "quota_exceeded" };
  }
  if (error instanceof IdentityError) {
    return { status: error.status, message: error.message, outcome: "unauthenticated" };
  }
  if (error instanceof EntitlementError) {
    return {
      status: error.status,
      message: error.message,
      outcome: error.status === 409 ? "contract_mismatch" : error.status === 503 ? "disabled" : "not_entitled"
    };
  }
  return { status: 500, message: "The AI service failed to handle this request.", outcome: "error" };
}
