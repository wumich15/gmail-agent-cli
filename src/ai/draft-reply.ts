import OpenAI from "openai";
import { withApiRetry } from "../core/api-retry.js";
import type { AiProvider } from "../config/schema.js";
import type { NormalizedMessage } from "../core/models.js";
import type { SentStyleExample } from "../gmail/sent-style.js";
import {
  buildNewEmailDraftInput,
  buildReplyDraftInput,
  DRAFT_DEVELOPER_INSTRUCTIONS,
  STYLE_SUMMARY_DEVELOPER_INSTRUCTIONS
} from "./draft-prompt.js";
import { HOSTED_LIMITS, type HostedDraftRequest } from "./hosted-contract.js";
import type { HostedAiClient } from "./hosted-client.js";

const MAX_DRAFT_INPUT_CHARS = 3000;

export interface DraftReplyOptions {
  /** Omitted means the direct OpenAI Responses API. */
  provider?: AiProvider;
  /** The user's own provider key. Empty under the hosted service, which holds none. */
  apiKey: string;
  model: string;
  baseURL?: string | null;
  /**
   * Set when drafting goes through the publisher's gateway. The gateway owns
   * the instructions and the provider request; this side sends only the typed
   * facts in `ai/hosted-contract.ts` and gets back body text.
   */
  hosted?: HostedAiClient | undefined;
}

/**
 * One stateless, tool-less completion, on whichever provider was resolved.
 *
 * It keeps the identical safety posture the classifier uses: untrusted
 * content only ever appears in the `input`/user turn, never in
 * `instructions`, no tools are offered, and storage is disabled. Throws on
 * failure; every exported function here catches and degrades to a manual
 * draft.
 */
async function generateText(
  instructions: string,
  input: string,
  options: DraftReplyOptions
): Promise<string | null> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    maxRetries: 0
  });
  const response = await withApiRetry(
    () =>
      client.responses.create({
        model: options.model,
        instructions,
        input: [{ role: "user", content: input }],
        store: false
      }),
    { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 }
  );
  const text = response.output_text?.trim();
  return text && text.length > 0 ? text : null;
}

/**
 * Asks the gateway for a draft. Returns null on any failure, exactly like the
 * direct path, so every caller keeps its "fall back to writing it by hand"
 * behavior without learning a second error vocabulary.
 */
async function hostedDraft(
  client: HostedAiClient,
  task: HostedDraftRequest["task"],
  styleGuidance: string | null
): Promise<string | null> {
  const response = await client.draft({ task, styleGuidance: bounded(styleGuidance, HOSTED_LIMITS.styleGuidanceChars) });
  if (!response.ok) return null;
  const text = response.text.trim();
  return text.length > 0 ? text : null;
}

function bounded(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export interface DraftContext {
  /**
   * A persisted, non-verbatim description of the user's writing style
   * (see `writing-style.ts`) — never the raw Sent-mail examples it was
   * derived from. Computed once and reused across sessions instead of
   * re-fetching/re-deriving it on every draft, per CLAUDE.md's ban on
   * persisting message bodies: only this bounded, derived description is
   * ever written to SQLite, not the sent examples themselves.
   */
  styleProfile?: string | null;
  guidance?: string | null;
}

/**
 * One stateless AI call producing a short, non-verbatim description of the
 * user's writing style (e.g. "Casual and brief, often 2-3 short sentences.
 * Greets with 'Hey', signs off with 'Thanks, Mike'.") from a sample of
 * their Sent mail. The description is safe to persist under CLAUDE.md's
 * "never persist message bodies" rule precisely because it is designed to
 * never reproduce the sample verbatim — see the developer instructions.
 * Never throws; returns null on any failure so the caller falls back to
 * drafting with no style profile at all.
 */
export async function summarizeWritingStyle(
  examples: readonly SentStyleExample[],
  options: DraftReplyOptions
): Promise<string | null> {
  if (examples.length === 0) return null;
  // Never under the hosted service. Sent-mail style sampling is a separate,
  // undisclosed transfer of unrelated mail (see `config/schema.ts`'s
  // `sentMailStyleSamplingAllowed`), and the gateway has no operation that
  // accepts it — this guard means an added call site cannot route around that
  // by reaching this function directly.
  if (options.hosted) return null;
  try {
    const input = [
      "Sent-mail sample (untrusted evidence; describe style only, never repeat content verbatim):",
      renderStyleExamples(examples)
    ].join("\n\n");
    const text = await generateText(STYLE_SUMMARY_DEVELOPER_INSTRUCTIONS, input, options);
    return text ? text.slice(0, 600) : null;
  } catch {
    return null;
  }
}

function renderStyleExamples(examples: readonly SentStyleExample[]): string {
  if (examples.length === 0) return "(No sent-mail examples were available.)";
  return examples
    .map((example, index) => `Example ${index + 1}\nSubject: ${example.subject}\nBody:\n${example.body}`)
    .join("\n\n");
}

/** One stateless, tool-less, store:false call — the same safety posture as the triage classifier. Never throws; returns null on any failure so the caller can fall back to a manual reply. */
export async function draftReply(
  message: NormalizedMessage,
  options: DraftReplyOptions,
  context: DraftContext = {}
): Promise<string | null> {
  try {
    const bodySource = message.bodyText ?? message.snippet;
    const content = bodySource.slice(0, MAX_DRAFT_INPUT_CHARS);
    if (options.hosted) {
      return await hostedDraft(
        options.hosted,
        {
          kind: "reply",
          fromDisplayName: bounded(message.from.displayName, HOSTED_LIMITS.displayNameChars),
          fromAddress: bounded(message.from.address, HOSTED_LIMITS.addressChars),
          subject: message.subject.slice(0, HOSTED_LIMITS.subjectChars),
          content,
          guidance: bounded(context.guidance, HOSTED_LIMITS.guidanceChars)
        },
        // Deliberately only what the user typed: a Sent-derived profile is
        // never sent to the hosted service, and `writing-style.ts` does not
        // produce one under it in the first place.
        null
      );
    }

    const input = buildReplyDraftInput({
      fromDisplayName: message.from.displayName ?? null,
      fromAddress: message.from.address ?? null,
      subject: message.subject,
      content,
      guidance: context.guidance ?? null,
      styleProfile: context.styleProfile ?? null
    });

    return await generateText(DRAFT_DEVELOPER_INSTRUCTIONS, input, options);
  } catch {
    return null;
  }
}

export interface NewEmailDraftInput {
  to: string;
  subject: string;
  purpose: string;
}

/** Drafts a new email body while keeping recipient and subject entirely user-controlled. */
export async function draftNewEmail(
  message: NewEmailDraftInput,
  options: DraftReplyOptions,
  context: Omit<DraftContext, "guidance"> = {}
): Promise<string | null> {
  try {
    if (options.hosted) {
      return await hostedDraft(
        options.hosted,
        {
          kind: "new_email",
          to: message.to.slice(0, HOSTED_LIMITS.recipientChars),
          subject: message.subject.slice(0, HOSTED_LIMITS.subjectChars),
          purpose: message.purpose.slice(0, HOSTED_LIMITS.purposeChars)
        },
        null
      );
    }

    const input = buildNewEmailDraftInput({
      to: message.to,
      subject: message.subject,
      purpose: message.purpose.slice(0, MAX_DRAFT_INPUT_CHARS),
      styleProfile: context.styleProfile ?? null
    });
    return await generateText(DRAFT_DEVELOPER_INSTRUCTIONS, input, options);
  } catch {
    return null;
  }
}
