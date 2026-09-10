import * as p from "@clack/prompts";
import pc from "picocolors";
import { reloadConfig, type CliContext } from "../core/bootstrap.js";
import { loadOrCreateDefaultConfig } from "../config/load.js";
import { applyAiAccessChoice, checkLocalRuntime, currentAiAccess, AI_ACCESS_OPTIONS, type AiAccessId } from "../core/ai-access.js";
import { DEFAULT_LOCAL_MODEL } from "../config/schema.js";

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

  p.log.message(
    "How should this app get AI for classifying mail and drafting replies?\n\n" +
      AI_ACCESS_OPTIONS.map((option) => `${pc.bold(option.title)}\n  ${option.summary}\n  ${pc.dim(option.requirements)}`).join(
        "\n\n"
      )
  );

  const selected = await p.select({
    message: "Choose how to get AI",
    initialValue: current,
    options: AI_ACCESS_OPTIONS.map((option) => ({ value: option.id, label: option.title }))
  });
  if (p.isCancel(selected)) {
    p.log.info("Left the AI setting unchanged.");
    return null;
  }
  const choice = selected as AiAccessId;

  let apiKey: string | null = null;
  let localModel: string | undefined;

  if (choice === "api-key") {
    const consent = await p.confirm({
      message: "Send selected message text (never attachments) to the OpenAI API, at your own cost?",
      initialValue: false
    });
    if (p.isCancel(consent) || !consent) {
      p.log.info("Not enabling hosted AI. Nothing was changed.");
      return null;
    }
    // Typed, not echoed, and stored in the OS credential store — never in
    // config.json, a log line, a CLI flag, or shell history.
    const entered = await p.password({ message: "OpenAI API key (stored in your OS keychain)" });
    if (p.isCancel(entered) || !entered.trim()) {
      p.log.info("No key entered. Nothing was changed.");
      return null;
    }
    apiKey = entered.trim();
  }

  if (choice === "local") {
    const spinner = p.spinner();
    spinner.start("Looking for a local model runtime");
    const runtime = await checkLocalRuntime();
    spinner.stop(runtime.reachable ? "Local runtime found." : "No local runtime is running yet.");
    if (runtime.reachable && runtime.models.length > 0) {
      const picked = await p.select({
        message: "Which local model should this app use?",
        options: runtime.models.map((name) => ({ value: name, label: name }))
      });
      if (!p.isCancel(picked)) localModel = picked as string;
    } else {
      p.log.warn(
        `${runtime.problem ?? "The local runtime is not reachable."}\n` +
          `Install Ollama from https://ollama.com, then run: ollama pull ${DEFAULT_LOCAL_MODEL}\n` +
          "The setting is saved either way; until the runtime is running, runs fall back to rules only."
      );
    }
  }

  const config = ctx.config ?? loadOrCreateDefaultConfig(Intl.DateTimeFormat().resolvedOptions().timeZone);
  await applyAiAccessChoice({
    config,
    choice,
    apiKey,
    accountHash,
    credentialStore: ctx.credentialStore,
    localModel
  });
  reloadConfig(ctx);

  p.log.success(
    choice === "off"
      ? "AI is off. Runs will use rules only."
      : choice === "local"
        ? `Using a local model (${localModel ?? DEFAULT_LOCAL_MODEL}). No mail will leave this computer.`
        : "Using the OpenAI API with your key."
  );
  return choice;
}
