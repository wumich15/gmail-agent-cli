import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Classifier } from "../ai/classifier.js";
import { googleApiRateLimiter, subscribeGoogleApiAttempts } from "../core/api-retry.js";

/** Persistent, content-free breadcrumbs survive a run that never reaches its final summary. */
export function startRunDiagnostics(logger: Logger, command: "work" | "cache", limit?: number) {
  const log = logger.child({ diagnosticRunId: randomUUID(), command });
  const startedAt = performance.now();
  let phase = "setup";
  let phaseStartedAt = startedAt;
  let aiCall = 0;
  let aiInFlight = 0;
  const pending = new Map<number, { stage: string; operation: string; since: number }>();
  const unsubscribe = subscribeGoogleApiAttempts((event) => {
    if (event.stage === "queued" || event.stage === "started") {
      pending.set(event.requestId, { stage: event.stage, operation: event.operation, since: performance.now() });
    } else { pending.delete(event.requestId); }
    log.info(event, "google_api_attempt");
  });
  const setPhase = (next: string): void => {
    if (next === phase) return;
    log.info({ phase, elapsedMs: Math.round(performance.now() - phaseStartedAt) }, "run_phase_finished");
    phase = next;
    phaseStartedAt = performance.now();
    log.info({ phase }, "run_phase_started");
  };
  log.info({ limit: limit ?? null, transport: "individual", requestsPerSecond: googleApiRateLimiter.currentRequestsPerSecond }, "run_diagnostics_started");
  const timer = setInterval(() => {
    log.info({ phase, elapsedMs: Math.round(performance.now() - startedAt), aiInFlight,
      pending: [...pending.values()].map((item) => ({ stage: item.stage, operation: item.operation, elapsedMs: Math.round(performance.now() - item.since) })),
      requestsPerSecond: googleApiRateLimiter.currentRequestsPerSecond,
      quotaCooldownMs: googleApiRateLimiter.quotaCooldownRemainingMs }, "run_heartbeat");
  }, 10_000);
  timer.unref();
  return {
    phase: setPhase,
    classifier(classifier: Classifier): Classifier {
      return { assess: async (message, context) => {
        setPhase("classification");
        const call = ++aiCall;
        const start = performance.now();
        aiInFlight += 1;
        log.info({ call }, "ai_assessment_started");
        try {
          const result = await classifier.assess(message, context);
          log.info({ call, elapsedMs: Math.round(performance.now() - start), ok: result.ok }, "ai_assessment_finished");
          return result;
        } catch (error) {
          log.info({ call, elapsedMs: Math.round(performance.now() - start), ok: false }, "ai_assessment_finished");
          throw error;
        } finally { aiInFlight -= 1; }
      } };
    },
    finish() {
      clearInterval(timer);
      unsubscribe();
      setPhase("finished");
      log.info({ elapsedMs: Math.round(performance.now() - startedAt) }, "run_diagnostics_finished");
      log.flush();
    }
  };
}
