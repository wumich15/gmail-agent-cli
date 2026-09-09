import { z } from "zod";

/** Triage/classification: one cheap call per unresolved message, every run. */
export const DEFAULT_MODEL = "gpt-5.4-mini";

/**
 * Composing and replying in `gmail view`. Deliberately a stronger model than
 * classification: drafting happens a handful of times per session, entirely
 * at the user's request, and its output is prose the user will read, edit,
 * and put their own name on — so quality matters far more than per-call cost.
 * Triage is the opposite trade (thousands of calls, a tiny enum out), which
 * is why the two are configured separately rather than sharing one model.
 */
export const DEFAULT_COMPOSE_MODEL = "gpt-5.6-luna";

/**
 * In-flight Gmail reads. The shared limiter (see `core/api-retry.ts`) caps
 * the real request *rate*, so this only decides how much of the per-minute
 * allowance can be spent at once — and since that limiter now admits a whole
 * burst rather than spacing reads out evenly, concurrency is what a short
 * run's wall-clock time actually depends on. 8 matches what `gmail cache`
 * has always used.
 */
export const DEFAULT_GMAIL_READ_CONCURRENCY = 8;

/**
 * "openai" talks to the standard OpenAI API. "openai-compatible" points at
 * any endpoint implementing the same Responses API + Structured Outputs
 * shape — e.g. a self-hosted model server — via `aiBaseUrl`, so a user is
 * not required to hold an OpenAI API key specifically. Neither is wired to
 * a real network call yet; see `src/ai/not-configured-classifier.ts`.
 */
export const AI_PROVIDERS = ["openai", "openai-compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** Config on disk is non-secret. Secrets always live in the credential store. */
export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    timezone: z.string().min(1),
    automationEnabled: z.boolean().default(false),
    aiEnabled: z.boolean().default(false),
    aiProvider: z.enum(AI_PROVIDERS).default("openai"),
    /** Required when aiProvider is "openai-compatible"; ignored otherwise. */
    aiBaseUrl: z.string().url().optional(),
    model: z.string().min(1).default(DEFAULT_MODEL),
    composeModel: z.string().min(1).default(DEFAULT_COMPOSE_MODEL),
    concurrency: z
      .object({
        gmailReads: z.number().int().min(1).max(20).default(DEFAULT_GMAIL_READ_CONCURRENCY),
        aiCalls: z.number().int().min(1).max(10).default(5),
        calendarWrites: z.number().int().min(1).max(10).default(2)
      })
      .strict()
      .default({ gmailReads: DEFAULT_GMAIL_READ_CONCURRENCY, aiCalls: 5, calendarWrites: 2 }),
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
  .strict()
  .refine((config) => config.aiProvider !== "openai-compatible" || config.aiBaseUrl !== undefined, {
    message: "aiBaseUrl is required when aiProvider is \"openai-compatible\"",
    path: ["aiBaseUrl"]
  });

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(timezone: string): Config {
  const aiProvider = (process.env["GMAIL_AGENT_AI_PROVIDER"] as AiProvider | undefined) ?? "openai";
  const aiBaseUrl = process.env["GMAIL_AGENT_AI_BASE_URL"];
  return ConfigSchema.parse({
    schemaVersion: 1,
    timezone,
    automationEnabled: false,
    aiEnabled: false,
    aiProvider,
    ...(aiBaseUrl ? { aiBaseUrl } : {}),
    model: process.env["GMAIL_AGENT_MODEL"] ?? DEFAULT_MODEL,
    composeModel: process.env["GMAIL_AGENT_COMPOSE_MODEL"] ?? DEFAULT_COMPOSE_MODEL,
    concurrency: { gmailReads: DEFAULT_GMAIL_READ_CONCURRENCY, aiCalls: 5, calendarWrites: 2 },
    telemetryEnabled: false
  });
}

export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw);
}
