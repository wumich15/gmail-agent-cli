import { z } from "zod";
import { EmailFlagsSchema } from "./schema.js";

/**
 * The complete wire contract between this CLI and the publisher's AI
 * gateway. Both sides import these schemas, so neither can quietly widen
 * what the other accepts.
 *
 * Two properties matter more than the field list itself:
 *
 * 1. **It is not a model API.** There is no model ID, no provider name, no
 *    base URL, no tool list, no message array, no temperature — nothing a
 *    caller could use to turn the publisher's funded credential into
 *    general-purpose inference. The gateway builds the entire provider
 *    request itself from these typed facts (see `src/gateway/`).
 * 2. **It carries only what the disclosure named.** Sender, subject, sent
 *    date, timezone, a derived bulk-mail boolean, existing label names, and
 *    bounded plain text — never attachments, raw HTML, headers, Gmail
 *    credentials, the local ledger, or unrelated Sent mail.
 *
 * `additionalProperties` is closed everywhere (`.strict()`), so an older
 * gateway rejects a field a newer CLI invents rather than ignoring it.
 */

/**
 * Bumped when the shape of these operations changes, or when the publisher
 * pins a different model generation behind them. The CLI sends it on every
 * request and folds it into the assessment cache key; the gateway rejects a
 * version it does not implement with a clear "upgrade the CLI" message
 * rather than silently serving a different contract.
 */
export const HOSTED_CONTRACT_VERSION = 1;

/**
 * Bounds applied identically on both sides. The CLI truncates to them before
 * sending (so a long message degrades rather than failing), and the gateway
 * rejects anything past them (so a modified client cannot spend the
 * publisher's budget on a giant prompt).
 */
export const HOSTED_LIMITS = {
  subjectChars: 500,
  addressChars: 320,
  displayNameChars: 200,
  contentChars: 4000,
  guidanceChars: 1000,
  purposeChars: 3000,
  styleGuidanceChars: 600,
  labelNameChars: 100,
  labelCount: 200,
  recipientChars: 1000
} as const;

const HostedClassifyMessageSchema = z
  .object({
    fromDisplayName: z.string().max(HOSTED_LIMITS.displayNameChars).nullable(),
    fromAddress: z.string().max(HOSTED_LIMITS.addressChars).nullable(),
    subject: z.string().max(HOSTED_LIMITS.subjectChars),
    /** YYYY-MM-DD, or null when Gmail reported no usable internal date. */
    sentDate: z.string().max(10).nullable(),
    userTimeZone: z.string().max(100).nullable(),
    bulkSignal: z.boolean(),
    content: z.string().max(HOSTED_LIMITS.contentChars),
    contentIsFullBody: z.boolean(),
    truncated: z.boolean()
  })
  .strict();

export const HostedClassifyRequestSchema = z
  .object({
    contractVersion: z.literal(HOSTED_CONTRACT_VERSION),
    message: HostedClassifyMessageSchema,
    existingLabels: z
      .array(z.string().max(HOSTED_LIMITS.labelNameChars))
      .max(HOSTED_LIMITS.labelCount)
      .default([])
  })
  .strict();

export type HostedClassifyRequest = z.infer<typeof HostedClassifyRequestSchema>;

/**
 * A failed assessment is a normal, typed outcome rather than an HTTP error:
 * the CLI must be able to tell "the model refused/was unavailable" (leave the
 * message for Review) apart from "you are not authorized / out of allowance"
 * (stop asking), and only the latter should look like a transport failure.
 */
export const HOSTED_FAILURE_REASONS = [
  "refused",
  "schema_failure",
  "provider_unavailable",
  "timeout"
] as const;

export const HostedClassifyResponseSchema = z
  .discriminatedUnion("ok", [
    z
      .object({
        ok: z.literal(true),
        flags: EmailFlagsSchema,
        /** The exact pinned model snapshot that produced this, for the audit trail. */
        modelVersion: z.string().max(200)
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        reason: z.enum(HOSTED_FAILURE_REASONS),
        detail: z.string().max(500)
      })
      .strict()
  ]);

export type HostedClassifyResponse = z.infer<typeof HostedClassifyResponseSchema>;

const HostedReplyTaskSchema = z
  .object({
    kind: z.literal("reply"),
    fromDisplayName: z.string().max(HOSTED_LIMITS.displayNameChars).nullable(),
    fromAddress: z.string().max(HOSTED_LIMITS.addressChars).nullable(),
    subject: z.string().max(HOSTED_LIMITS.subjectChars),
    content: z.string().max(HOSTED_LIMITS.contentChars),
    guidance: z.string().max(HOSTED_LIMITS.guidanceChars).nullable()
  })
  .strict();

const HostedNewEmailTaskSchema = z
  .object({
    kind: z.literal("new_email"),
    to: z.string().max(HOSTED_LIMITS.recipientChars),
    subject: z.string().max(HOSTED_LIMITS.subjectChars),
    purpose: z.string().max(HOSTED_LIMITS.purposeChars)
  })
  .strict();

export const HostedDraftRequestSchema = z
  .object({
    contractVersion: z.literal(HOSTED_CONTRACT_VERSION),
    task: z.discriminatedUnion("kind", [HostedReplyTaskSchema, HostedNewEmailTaskSchema]),
    /**
     * Style guidance the user typed themselves, never a profile derived from
     * their Sent mail.
     *
     * Hosted AI deliberately does not sample Sent mail (see
     * `gmail/writing-style.ts`): that feature reads up to a dozen unrelated
     * messages the user did not select for this draft, which is a materially
     * different transfer from "draft a reply to the message I am looking at"
     * and must not ride along on the same consent. There is therefore no
     * field here that a derived Sent-mail profile could occupy.
     */
    styleGuidance: z.string().max(HOSTED_LIMITS.styleGuidanceChars).nullable().default(null)
  })
  .strict();

export type HostedDraftRequest = z.infer<typeof HostedDraftRequestSchema>;

export const HostedDraftResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      /** Plain-text body only. Never a recipient, subject, or header. */
      text: z.string().max(20_000),
      modelVersion: z.string().max(200)
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(HOSTED_FAILURE_REASONS),
      detail: z.string().max(500)
    })
    .strict()
]);

export type HostedDraftResponse = z.infer<typeof HostedDraftResponseSchema>;

export const HostedSessionBootstrapRequestSchema = z
  .object({
    googleIdToken: z.string().min(1).max(8000),
    policyVersion: z.string().min(1).max(100),
    hostedAiAccepted: z.literal(true)
  })
  .strict();

export type HostedSessionBootstrapRequest = z.infer<typeof HostedSessionBootstrapRequestSchema>;
