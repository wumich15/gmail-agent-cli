import * as p from "@clack/prompts";
import pc from "picocolors";
import { reloadConfig, type CliContext } from "../core/bootstrap.js";
import { loadOrCreateDefaultConfig } from "../config/load.js";
import {
  aiAccessOption,
  applyAiAccessChoice,
  availableAiAccessOptions,
  currentAiAccess,
  type AiAccessId
} from "../core/ai-access.js";

/**
 * The interactive half of the AI access choice. The decision itself, the
 * option text, and the writes all live in `core/ai-access.ts` so the
 * browser setup view can offer exactly the same choice with the same
 * disclosures — this file only asks the questions.
 *
 * Two rules this flow must never break: the normal path never asks for an
 * API key (the key option is offered, but it is explicitly the advanced
 * one), and no option is selectable before its cost, hardware, and
 * data-sharing consequences have been shown.
 */
export async function chooseAiAccessInteractively(ctx: CliContext, accountHash: string): Promise<AiAccessId | null> {
  const current = currentAiAccess(ctx.config);
  const available = availableAiAccessOptions();
  const options = available.some((option) => option.id === current) ? available : [aiAccessOption(current), ...available];

  p.log.message(
    "How should this app get AI for classifying mail and drafting replies?\n\n" +
      options.map((option) => `${pc.bold(option.title)}\n  ${option.summary}\n  ${pc.dim(option.requirements)}`).join(
        "\n\n"
      )
  );

  const selected = await p.select({
    message: "Choose how to get AI",
    initialValue: current,
    options: options.map((option) => ({ value: option.id, label: option.title }))
  });
  if (p.isCancel(selected)) {
    p.log.info("Left the AI setting unchanged.");
    return null;
  }
  const choice = selected as AiAccessId;

  let apiKey: string | null = null;
  if (aiAccessOption(choice).sendsMailOffDevice) {
    const consent = await p.confirm({
      message:
        choice === "managed"
          ? "Send selected message text (never attachments) through the publisher service to OpenAI?"
          : "Send selected message text (never attachments) to the OpenAI API, at your own cost?",
      initialValue: false
    });
    if (p.isCancel(consent) || !consent) {
      p.log.info("Not enabling hosted AI. Nothing was changed.");
      return null;
    }
    if (choice === "api-key") {
      // Typed, not echoed, and stored in the OS credential store — never in
      // config.json, a log line, a CLI flag, or shell history.
      const entered = await p.password({ message: "OpenAI API key (stored in your OS keychain)" });
      if (p.isCancel(entered) || !entered.trim()) {
        p.log.info("No key entered. Nothing was changed.");
        return null;
      }
      apiKey = entered.trim();
    }
  }

  const config = ctx.config ?? loadOrCreateDefaultConfig(Intl.DateTimeFormat().resolvedOptions().timeZone);
  await applyAiAccessChoice({
    config,
    choice,
    apiKey,
    accountHash,
    credentialStore: ctx.credentialStore
  });
  reloadConfig(ctx);

  p.log.success(
    choice === "off"
      ? "AI is off. Runs will use rules only."
      : choice === "managed"
        ? "Using included GPT. You do not need an OpenAI API key."
        : "Using the OpenAI API with your key."
  );
  return choice;
}
