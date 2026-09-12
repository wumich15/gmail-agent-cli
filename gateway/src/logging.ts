/**
 * Content-free request logging.
 *
 * This service sees people's mail. The single most consequential operational
 * rule it has is that none of that text may be written anywhere it could be
 * read later, and a structured logger that accepts an arbitrary object is the
 * easiest possible way to break that rule by accident. So there is exactly
 * one log function, it takes a fixed set of fields, and none of them can hold
 * message content: no subject, no sender, no body, no prompt, no model
 * output, no bearer token, no email address, no Google subject, no provider
 * error body.
 *
 * The pseudonymous user ID is the only identifier recorded, and it is not
 * reversible without the HMAC key in Secret Manager.
 */

export interface RequestLogFields {
  operation: "session.bootstrap" | "session.revoke" | "ai.classify" | "ai.draft";
  userId: string | null;
  status: number;
  durationMs: number;
  /** Allowlisted outcome class, never a raw provider or exception message. */
  outcome:
    | "ok"
    | "unauthenticated"
    | "not_entitled"
    | "quota_exceeded"
    | "bad_request"
    | "contract_mismatch"
    | "provider_failed"
    | "disabled"
    | "error";
  /** Token count from the provider, for cost monitoring. Never token text. */
  totalTokens?: number;
  contractVersion?: number;
}

export function logRequest(fields: RequestLogFields): void {
  // Cloud Logging picks up structured JSON on stdout, and `severity` is the
  // field it reads for log level. Warnings and errors are separated so an
  // alert can fire on real failures without the noise of ordinary rejections.
  const severity = fields.status >= 500 ? "ERROR" : fields.status >= 400 ? "WARNING" : "INFO";
  process.stdout.write(`${JSON.stringify({ severity, service: "gmail-agent-gateway", ...fields })}\n`);
}
