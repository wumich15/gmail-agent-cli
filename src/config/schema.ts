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
 * How this install reaches a model.
 *
 * - "openai": the standard OpenAI API, called directly from this computer
 *   with the user's own key. This is the normal path.
 * - "openai-compatible": any endpoint implementing the same Responses API +
 *   Structured Outputs shape, via `aiBaseUrl` — including a model the user
 *   runs themselves. Still key-authenticated.
 *
 * There is deliberately no hosted/publisher option: this tool has no server,
 * so nobody else's key, quota, or infrastructure is ever in the path.
 */
export const AI_PROVIDERS = ["openai", "openai-compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * `1` predates `aiEnabled` being an effective switch: every v1 file on disk
 * was written with `aiEnabled: false` while a usable API key still activated
 * AI, so the flag cannot be read literally from those files. `loadConfig`
 * migrates v1 by recording what those installs were actually doing
 * (`aiEnabled: true`), after which the field means exactly what it says.
 */
export const CURRENT_CONFIG_SCHEMA_VERSION = 3;

/** Providers that earlier schema versions offered and this one no longer has. */
const RETIRED_PROVIDERS = new Set(["ollama", "managed"]);

/**
 * Schema v2 briefly offered a local-runtime path, and a later revision
 * briefly offered a hosted publisher gateway. Neither exists now: AI is the
 * user's own OpenAI key or nothing. A config naming either is rewritten to
 * the direct OpenAI provider, discarding the incompatible base URL and model
 * names, and `aiEnabled` is cleared so setup asks again rather than silently
 * assuming the user wants to start paying OpenAI directly.
 */
function replaceRetiredProvider(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  if (typeof value["aiProvider"] !== "string" || !RETIRED_PROVIDERS.has(value["aiProvider"])) return raw;
  const upgraded = { ...value };
  delete upgraded["aiBaseUrl"];
  return {
    ...upgraded,
    aiProvider: "openai",
    aiEnabled: false,
    model: DEFAULT_MODEL,
    composeModel: DEFAULT_COMPOSE_MODEL
  };
}

/** Config on disk is non-secret. Secrets always live in the credential store. */
export const ConfigSchema = z.preprocess(
  replaceRetiredProvider,
  z
    .object({
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    timezone: z.string().min(1),
    automationEnabled: z.boolean().default(false),
    /**
     * A real off switch as of schema v2: when false, no classification or
     * drafting call is made even if a usable provider is configured. Set
     * from the explicit AI-access choice during setup.
     */
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
    })
);

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Upgrades a config read from disk to the current schema version, returning
 * null when it is already current. See CURRENT_CONFIG_SCHEMA_VERSION for why
 * v1's `aiEnabled: false` must become `true` rather than being trusted: those
 * installs really were running AI whenever a key resolved, and silently
 * turning classification off under them would be a behavior regression
 * disguised as a schema change.
 */
export function migrateConfig(config: Config): Config | null {
  if (config.schemaVersion === CURRENT_CONFIG_SCHEMA_VERSION) {
    return null;
  }
  return {
    ...config,
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    aiEnabled: config.schemaVersion === 1 ? true : config.aiEnabled
  };
}

export function defaultConfig(timezone: string): Config {
  const aiProvider = (process.env["GMAIL_AGENT_AI_PROVIDER"] as AiProvider | undefined) ?? "openai";
  const aiBaseUrl = process.env["GMAIL_AGENT_AI_BASE_URL"];
  // A fresh config must not silently disable AI for the documented
  // headless/automation path, where the operator configures the provider
  // through the environment and never sees an interactive setup prompt.
  // Interactive setup calls `applyAiAccessChoice` and sets this explicitly.
  const configuredByEnvironment =
    Boolean(process.env["OPENAI_API_KEY"]) ||
    Boolean(process.env["GMAIL_AGENT_AI_PROVIDER"]) ||
    Boolean(process.env["GMAIL_AGENT_AI_BASE_URL"]);
  return ConfigSchema.parse({
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    timezone,
    automationEnabled: false,
    aiEnabled: configuredByEnvironment,
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
