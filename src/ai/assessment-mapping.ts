import { buildDeterministicSummary, normalizeCategoryLabel, PROMPT_VERSION } from "./prompt.js";
import type { EmailFlags } from "./schema.js";
import type { EmailAssessment, NormalizedMessage } from "../core/models.js";

/**
 * Version of the wire schema in `ai/schema.ts`, and therefore part of the
 * assessment cache key. Lives here rather than beside one provider because
 * every classifier — hosted or local — produces this exact shape.
 */
export const SCHEMA_VERSION = "schema-v5";

/** Clearly above/below the 0.90 policy thresholds — the flags themselves are the decision; these just satisfy the existing threshold-based policy engine. */
const HIGH_CONFIDENCE = 0.98;
const LOW_CONFIDENCE = 0;

/**
 * Deterministically maps the model's cheap `tag` (replacing the earlier
 * spam/suspicious/important boolean triplet — see schema.ts) onto the
 * richer internal EmailAssessment shape core/policy.ts already knows how
 * to consume, at fixed confidence values that clearly clear or miss its
 * 0.90 thresholds — the tag *is* the decision; these numbers only exist
 * to satisfy a policy engine built around graded confidence. `suspicious`
 * maps to a kind policy.ts already treats as "no AI-derived mutation,
 * route to Review," so a model output that also set event/category
 * fields for a suspicious tag is still safe by construction (and this
 * function additionally zeroes both out below, defense in depth).
 * `hasEvent` is inferred from `eventTitle !== null` rather than being its
 * own field, since the model has to fill in eventTitle either way.
 */
export function mapFlagsToAssessment(
  flags: EmailFlags,
  message: NormalizedMessage,
  classifierVersion: string
): EmailAssessment {
  const kind =
    flags.tag === "suspicious"
      ? "suspicious"
      : flags.tag === "spam"
        ? "promotion"
        : flags.tag === "important"
          ? "personal_important"
          : "personal_routine";
  const hasEvent = flags.eventTitle !== null;
  const isSuspicious = flags.tag === "suspicious";
  return {
    kind,
    confidence: isSuspicious || flags.tag === "spam" ? HIGH_CONFIDENCE : LOW_CONFIDENCE,
    importanceScore: flags.tag === "important" ? HIGH_CONFIDENCE : LOW_CONFIDENCE,
    importanceConfidence: flags.tag === "important" ? HIGH_CONFIDENCE : LOW_CONFIDENCE,
    summary: buildDeterministicSummary(message),
    reasonCodes: [],
    // A suspicious message's extracted facts are never trusted for either
    // field — policy.ts's isUnresolvedKind gate already makes this safe
    // today (no star/event/label ever fires for a suspicious kind), but
    // enforcing it symmetrically here too means that invariant doesn't
    // depend entirely on a single downstream gate staying correct forever.
    event:
      hasEvent && !isSuspicious
        ? {
            intent: "create",
            confidence: HIGH_CONFIDENCE,
            title: flags.eventTitle,
            start: flags.eventStart,
            end: flags.eventEnd,
            allDay: flags.eventAllDay,
            timeZone: null,
            location: null,
            sourceEvidence: flags.eventSourceEvidence
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
    category: isSuspicious ? null : normalizeCategoryLabel(flags.category),
    classifierVersion,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION
  };
}
