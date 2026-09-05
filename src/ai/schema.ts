import { z } from "zod";

/**
 * Minimal, cheap wire schema: plain booleans instead of confidence
 * floats, no free-text summary, no reasonCodes array. Every field the
 * model has to fill in costs output tokens on every single call, so this
 * is kept as small as it can be while still letting the deterministic
 * mapping in openai-classifier.ts drive the exact same policy decisions
 * (trash/star/important/archive/calendar) as the richer internal
 * `EmailAssessment` type in core/models.ts, which is unchanged — only
 * what's asked of the model got smaller.
 */
export const EmailFlagsSchema = z
  .object({
    spam: z.boolean(),
    suspicious: z.boolean(),
    important: z.boolean(),
    hasEvent: z.boolean(),
    eventTitle: z.string().max(100).nullable(),
    eventStart: z.string().max(40).nullable(),
    eventEnd: z.string().max(40).nullable(),
    eventAllDay: z.boolean()
  })
  .strict();

export type EmailFlags = z.infer<typeof EmailFlagsSchema>;
