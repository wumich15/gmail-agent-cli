/**
 * Content-free operational telemetry for the publisher gateway.
 *
 * Phase 5 of the production plan requires availability, latency, error-rate,
 * quota-rejection, and spend dashboards plus alerting, and simultaneously
 * forbids recording Authorization headers, ID tokens, message text, prompts,
 * model responses, or the OpenAI key. Both requirements are met by keeping
 * every observable value in this module a counter, a duration, or an
 * allowlisted enum: there is deliberately no code path here that can accept a
 * prompt, a response, a token, or an email address.
 */

/** Allowlisted request outcomes. Anything not in this union is never logged. */
export type GatewayOutcome =
  | "ok"
  | "health"
  | "metrics"
  | "not_found"
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "too_large"
  | "quota_exceeded"
  | "upstream_error"
  | "internal_error"
  | "shutting_down";

export interface GatewayLogEvent {
  event: "gateway_request";
  requestId: string;
  method: string;
  route: string;
  status: number;
  outcome: GatewayOutcome;
  durationMs: number;
  /** Configured model name only — never request or response content. */
  model?: string;
  /** First 12 hex characters of the pseudonymous subject hash, for abuse correlation only. */
  subjectPrefix?: string;
}

export type GatewayLogger = (event: GatewayLogEvent) => void;

/** Default logger: one JSON line per request on stdout, safe for any log shipper. */
export const defaultGatewayLogger: GatewayLogger = (event) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
};

/**
 * In-process counters exposed in Prometheus text exposition format. The
 * gateway is a single instance while it uses SQLite (see docs/production.md),
 * so process-local counters are the accurate picture; a horizontally scaled
 * deployment must scrape each instance separately.
 */
export class GatewayMetrics {
  private readonly requests = new Map<string, number>();
  private readonly outcomes = new Map<GatewayOutcome, number>();
  private durationSumMs = 0;
  private durationCount = 0;
  private inFlight = 0;
  private upstreamFailures = 0;
  private readonly startedAtMs = Date.now();

  requestStarted(): void {
    this.inFlight += 1;
  }

  requestFinished(event: { route: string; status: number; outcome: GatewayOutcome; durationMs: number }): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const key = `${event.route}|${event.status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    this.outcomes.set(event.outcome, (this.outcomes.get(event.outcome) ?? 0) + 1);
    if (event.outcome === "upstream_error") this.upstreamFailures += 1;
    this.durationSumMs += event.durationMs;
    this.durationCount += 1;
  }

  get pendingRequests(): number {
    return this.inFlight;
  }

  render(): string {
    const lines: string[] = [
      "# HELP gmail_agent_gateway_requests_total Completed gateway requests by route and HTTP status.",
      "# TYPE gmail_agent_gateway_requests_total counter"
    ];
    for (const [key, count] of this.requests) {
      const [route, status] = key.split("|");
      lines.push(`gmail_agent_gateway_requests_total{route="${route}",status="${status}"} ${count}`);
    }
    lines.push(
      "# HELP gmail_agent_gateway_outcomes_total Completed gateway requests by allowlisted outcome class.",
      "# TYPE gmail_agent_gateway_outcomes_total counter"
    );
    for (const [outcome, count] of this.outcomes) {
      lines.push(`gmail_agent_gateway_outcomes_total{outcome="${outcome}"} ${count}`);
    }
    lines.push(
      "# HELP gmail_agent_gateway_upstream_failures_total Failed OpenAI calls, counted without provider diagnostics.",
      "# TYPE gmail_agent_gateway_upstream_failures_total counter",
      `gmail_agent_gateway_upstream_failures_total ${this.upstreamFailures}`,
      "# HELP gmail_agent_gateway_request_duration_seconds Total and count of request durations.",
      "# TYPE gmail_agent_gateway_request_duration_seconds summary",
      `gmail_agent_gateway_request_duration_seconds_sum ${(this.durationSumMs / 1000).toFixed(3)}`,
      `gmail_agent_gateway_request_duration_seconds_count ${this.durationCount}`,
      "# HELP gmail_agent_gateway_inflight_requests Requests currently being served.",
      "# TYPE gmail_agent_gateway_inflight_requests gauge",
      `gmail_agent_gateway_inflight_requests ${this.inFlight}`,
      "# HELP gmail_agent_gateway_uptime_seconds Seconds since this gateway process started.",
      "# TYPE gmail_agent_gateway_uptime_seconds gauge",
      `gmail_agent_gateway_uptime_seconds ${((Date.now() - this.startedAtMs) / 1000).toFixed(0)}`
    );
    return `${lines.join("\n")}\n`;
  }
}
