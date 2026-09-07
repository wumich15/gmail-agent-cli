import { z } from "zod";

/**
 * A single classification tag replacing three separate, largely
 * mutually-exclusive booleans (spam/suspicious/important) from an earlier
 * version of this schema — one enum field costs meaningfully fewer output
 * tokens per call than three boolean fields, at the same information
 * content (the prompt's own rule already said "at most one of
 * spam/suspicious should be true"). `openai-classifier.ts` still applies
 * exactly the same fixed-confidence mapping and policy thresholds this
 * tag drives as it did with the old boolean triplet — this is purely an
 * output-shape/cost change, not a policy change.
 */
export const EMAIL_TAGS = ["spam", "suspicious", "important", "routine"] as const;
export type EmailTag = (typeof EMAIL_TAGS)[number];

/**
 * Minimal, cheap wire schema: a single classification tag instead of
 * confidence floats or multiple overlapping booleans, no free-text
 * summary, no reasonCodes array. Every field the model has to fill in
 * costs output tokens on every single call, so this is kept as small as
 * it can be while still letting the deterministic mapping in
 * openai-classifier.ts drive the exact same policy decisions
 * (trash/star/important/archive/calendar) as the richer internal
 * `EmailAssessment` type in core/models.ts, which is unchanged — only
 * what's asked of the model got smaller. `hasEvent` was also dropped as
 * its own field: event presence is inferred from `eventTitle !== null`,
 * which the model has to fill in either way.
 */
export const EmailFlagsSchema = z
  .object({
    tag: z.enum(EMAIL_TAGS),
    eventTitle: z.string().max(100).nullable(),
    eventStart: z.string().max(40).nullable(),
    eventEnd: z.string().max(40).nullable(),
    eventAllDay: z.boolean(),
    /**
     * A short quote or close paraphrase of the exact text stating the
     * event's date/time, required whenever eventTitle is non-null — real
     * code (calendar/event-policy.ts's sourceEvidencePresent) verifies
     * this string is actually present in the normalized message before
     * any Calendar event is created, so a hallucinated or
     * signature/footer-invented date can't produce a real event just
     * because the model asserted one. Null whenever eventTitle is null.
     */
    eventSourceEvidence: z.string().max(200).nullable(),
    /** A short, memorable topical label name, or null if none fits. See prompt.ts. */
    category: z.string().max(30).nullable()
  })
  .strict();

export type EmailFlags = z.infer<typeof EmailFlagsSchema>;
