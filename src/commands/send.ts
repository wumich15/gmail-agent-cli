import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccountSigningInIfNeeded } from "./shared.js";
import { EXIT_CODES } from "../core/errors.js";
import { getWritingStyleProfile } from "../gmail/writing-style.js";
import { handleCompose } from "../gmail/compose-flow.js";
import type { ResolvedOpenAiCredentials } from "../ai/resolve-classifier.js";

export interface SendOptions {
  /** Pre-fills the "To" prompt when given (e.g. `gmail send someone@example.com`). */
  to?: string;
  /** Pre-fills the "Subject" prompt when given. */
  subject?: string;
  /** Skips the manual-vs-AI choice and drafts the body with AI directly. */
  ai: boolean;
}

/**
 * `gmail send` — compose and send one new email directly from the command
 * line. This is the exact same recipient/subject/body/confirm flow as
 * `gmail view`'s "c"/"a"/";c" commands (see `gmail/compose-flow.ts`), just
 * reachable without opening the interactive inbox first. Recipient and
 * subject are always either typed by the user or passed as flags — never
 * AI-derived. When drafting with AI, the model reuses the account's saved
 * writing-style profile (`gmail/writing-style.ts`), computing and
 * persisting it on first use exactly like `gmail view` does, rather than
 * re-deriving it every run. Nothing is sent without the user seeing the
 * exact final To/Subject/Body and explicitly confirming — there is no
 * flag that skips that confirmation (see CLAUDE.md's "Interactive mail").
 */
export async function runSend(options: SendOptions): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error(
      pc.red(
        "gmail send is interactive and requires a terminal (stdin is not a TTY) — it always shows the exact " +
          "message and asks for confirmation before sending."
      )
    );
    return EXIT_CODES.safetyBlocked;
  }

  const ctx = bootstrap();
  const { account, gmailClient } = await resolveAccountSigningInIfNeeded(ctx);

  const getStyleProfile = (
    credentials: ResolvedOpenAiCredentials,
    forceRefresh = false
  ): Promise<string | null> =>
    getWritingStyleProfile(
      {
        config: ctx.config,
        db: ctx.db,
        accountHash: account.accountHash,
        gmailClient,
        userEmail: account.emailDisplay ?? "",
        credentials,
        nowIso: () => ctx.clock.nowIso()
      },
      forceRefresh
    );

  // `--ai` goes straight to drafting; without it the shared flow asks, and
  // only offers AI when this account can actually run it.
  await handleCompose(gmailClient, account.accountHash, options.ai ? true : undefined, ctx, getStyleProfile, {
    ...(options.to !== undefined ? { to: options.to } : {}),
    ...(options.subject !== undefined ? { subject: options.subject } : {})
  });
  return EXIT_CODES.ok;
}
