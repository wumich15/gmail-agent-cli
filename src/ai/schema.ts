import { z } from "zod";
import { EMAIL_ASSESSMENT_KINDS, EVENT_INTENTS, REASON_CODES } from "../core/models.js";

/**
 * Strict Structured Outputs schema. Every property is required (nullable
 * where the model may have nothing to say), additionalProperties is
 * implicitly closed by using .strict(), and enums are closed. Structured
 * output guarantees shape, not truth — the deterministic policy is what
 * decides whether to act on it.
 */
export const EventCandidateSchema = z
  .object({
    intent: z.enum(EVENT_INTENTS),
    confidence: z.number().min(0).max(1),
    title: z.string().max(200).nullable(),
    start: z.string().max(40).nullable(),
    end: z.string().max(40).nullable(),
    allDay: z.boolean(),
    timeZone: z.string().max(64).nullable(),
    location: z.string().max(200).nullable(),
    sourceEvidence: z.string().max(280).nullable()
  })
  .strict();

export const EmailAssessmentSchema = z
  .object({
    kind: z.enum(EMAIL_ASSESSMENT_KINDS),
    confidence: z.number().min(0).max(1),
    importanceScore: z.number().min(0).max(1),
    importanceConfidence: z.number().min(0).max(1),
    summary: z.string().max(240),
    reasonCodes: z.array(z.enum(REASON_CODES)).max(8),
    event: EventCandidateSchema
  })
  .strict();

export type EmailAssessmentModelOutput = z.infer<typeof EmailAssessmentSchema>;
