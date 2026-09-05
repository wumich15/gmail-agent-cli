import { z } from "zod";

export const DEFAULT_MODEL = "gpt-5.6-terra";

/** Config on disk is non-secret. Secrets always live in the credential store. */
export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    timezone: z.string().min(1),
    automationEnabled: z.boolean().default(false),
    aiEnabled: z.boolean().default(false),
    model: z.string().min(1).default(DEFAULT_MODEL),
    concurrency: z
      .object({
        gmailReads: z.number().int().min(1).max(20).default(5),
        aiCalls: z.number().int().min(1).max(10).default(2),
        calendarWrites: z.number().int().min(1).max(10).default(2)
      })
      .strict()
      .default({ gmailReads: 5, aiCalls: 2, calendarWrites: 2 }),
    policyThresholds: z
      .object({
        autoTrashPromotionConfidence: z.number().min(0).max(1),
        autoTrashAutomatedLowValueConfidence: z.number().min(0).max(1),
        autoStarImportanceScore: z.number().min(0).max(1),
        autoStarImportanceConfidence: z.number().min(0).max(1),
        autoCreateEventConfidence: z.number().min(0).max(1)
      })
      .strict()
      .partial()
      .optional(),
    telemetryEnabled: z.boolean().default(false)
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(timezone: string): Config {
  return ConfigSchema.parse({
    schemaVersion: 1,
    timezone,
    automationEnabled: false,
    aiEnabled: false,
    model: process.env["GMAIL_AGENT_MODEL"] ?? DEFAULT_MODEL,
    concurrency: { gmailReads: 5, aiCalls: 2, calendarWrites: 2 },
    telemetryEnabled: false
  });
}

export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw);
}
