#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { runWork } from "./commands/work.js";
import { runAdd } from "./commands/add.js";
import { runCategory } from "./commands/category.js";
import { runCache } from "./commands/cache.js";
import { runUncache } from "./commands/uncache.js";
import { runView } from "./commands/view.js";
import { runSend } from "./commands/send.js";
import { GmailAgentError, EXIT_CODES } from "./core/errors.js";
import { redactSecrets } from "./logging/logger.js";

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive whole number.");
  }
  return parsed;
}

const VIEW_HELP_TEXT =
  "\nGmail view controls:\n" +
  "  up/down      move the highlighted row (no Enter needed)\n" +
  "  enter        open the highlighted row\n" +
  "  number       type email number to open\n" +
  "  <n> r        reply to message n immediately, without opening it first\n" +
  "  <n> ;r       AI-draft a reply to message n immediately (e.g. \"2 ;r\")\n" +
  "  <n> d        delete (Trash) message n immediately, without opening it\n" +
  "  d            delete (Trash) the highlighted row, without opening it\n" +
  "  left/right   previous or next page in the list (no Enter needed)\n" +
  "  n / p        next or previous page\n" +
  "  [ / ]        back or forward through prior list views\n" +
  "  esc          go home: clear search/filters, first page (never quits)\n" +
  "  + / -        increase or decrease page size\n" +
  "  l <number>   set an exact page size\n" +
  "  f            filter by Gmail label\n" +
  "  s <text>     search subjects and senders (s alone clears)\n" +
  "  c / a        compose manually or with AI\n" +
  "  ;s           refresh your saved writing style from recent Sent mail\n" +
  "  ;u           undo the last delete from this session\n" +
  "  u            refresh Gmail (also updates the \"cached ... ago\" timestamp)\n" +
  "  q            quit\n" +
  "  left/right   previous or next message while reading one\n" +
  "  r / ;r       reply manually or with AI while reading\n" +
  "  d            delete (move to Trash) while reading — default answer is yes\n" +
  "  l            show this message's link URLs (links are shown shortened\n" +
  "               and clickable in a terminal that supports it)\n" +
  "  o            open one of this message's links in your system browser\n" +
  "  esc          return to the message list\n" +
  "\n" +
  "The \"<n> r\"/\"<n> ;r\" shortcuts only jump straight to composing — the same\n" +
  "exact-message confirmation screen still appears before anything sends;\n" +
  "there is no way to skip it. \"Delete\" always means Gmail's Trash (reversible\n" +
  "from Gmail itself, or instantly via \";u\" for the last one this session),\n" +
  "never permanent deletion — deleting always updates the list immediately.\n";

// MVP command surface: `gmail` (scan + clean up, with inline sign-in on
// first run), `gmail add` (create a spam/important rule), `gmail category`
// (create a Gmail label directly, on demand), `gmail cache` (read-only
// full-inbox snapshot that seeds incremental scanning), `gmail uncache`
// (clears that local scan cache/history marker, no Gmail/Calendar changes),
// `gmail view` (terminal inbox with automatic cache refresh, reading,
// composing, replies, and Sent-style-aware AI drafts), and `gmail send`
// (the same compose/AI-draft/confirm flow as gmail view's "c"/"a", reachable
// directly from the command line). The other commands (spam/important/rules/summary/
// undo/auth/config/doctor) still exist as working code under
// src/commands/ — they're just not wired up as CLI subcommands yet.
// Re-add them here when they're back in scope.

const program = new Command();

program
  .name("gmail")
  .description("Local terminal agent that cleans up Gmail and creates Calendar events from actionable mail.")
  .version("0.1.0")
  .option("--dry-run", "preview without making changes", false)
  .option("--json", "emit a single JSON summary to stdout", false)
  .option(
    "--limit <n>",
    "cap the Inbox and native-Spam scans to the N most recent messages each (reduces Gmail API quota usage)",
    parsePositiveInt
  )
  .addHelpText(
    "after",
    VIEW_HELP_TEXT + "\nUse `gmail help <command>` for command-specific options (for example, `gmail help view`).\n"
  );

function withExitHandling(fn: () => Promise<number>): void {
  fn()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof GmailAgentError) {
        console.error(pc.red(error.message));
        process.exitCode = error.exitCode;
        return;
      }
      const raw = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(pc.red(redactSecrets(raw)));
      process.exitCode = EXIT_CODES.operationalFailure;
    });
}

program.action((opts: { dryRun: boolean; json: boolean; limit?: number }) => {
  withExitHandling(() =>
    runWork({ dryRun: opts.dryRun, json: opts.json, ...(opts.limit !== undefined ? { limit: opts.limit } : {}) })
  );
});

program
  .command("add <type> [categories...]")
  .description(
    'Add one or more rules: "gmail add spam <category>" or "gmail add important <category> <category2> ..."'
  )
  .option("--yes", "authorize the rule and its immediate current-message actions", false)
  .action((type: string, categories: string[], opts: { yes: boolean }) => {
    withExitHandling(() => runAdd(type, categories, { yes: opts.yes }));
  });

program
  .command("category <names...>")
  .description(
    'Create one or more Gmail labels directly, e.g. gmail category "Shopping" "Travel" ' +
      "(independent of the AI auto-labeling threshold in a normal gmail run)"
  )
  .action((names: string[]) => {
    withExitHandling(() => runCategory(names));
  });

program
  .command("cache")
  .description(
    "Read-only full snapshot of the whole Inbox and Spam, with no AI calls and no mutations, so every " +
      "gmail/gmail work run after it can scan incrementally instead of re-fetching everything"
  )
  .option(
    "--limit <n>",
    "cap the Inbox and native-Spam scans to the N most recent messages each (default: no cap — caches everything)",
    parsePositiveInt
  )
  .action((opts: { limit?: number }) => {
    withExitHandling(() => runCache({ ...(opts.limit !== undefined ? { limit: opts.limit } : {}) }));
  });

program
  .command("uncache")
  .description(
    "Clear this account's local scan cache and history marker (no Gmail/Calendar changes) — the inverse of " +
      "gmail cache. The next gmail/gmail work/gmail cache run afterward does a full snapshot again."
  )
  .option("--yes", "skip the confirmation prompt", false)
  .action((opts: { yes: boolean }) => {
    withExitHandling(() => runUncache({ yes: opts.yes }));
  });

program
  .command("view")
  .description(
    "Browse and refresh Gmail in the terminal: search/filter, read, compose, reply, and create Sent-style-aware AI drafts"
  )
  .option("--limit <n>", "messages per page (default: 20)", parsePositiveInt)
  .option("--previous", "open the existing Gmail cache without refreshing it first", false)
  .addHelpText("after", VIEW_HELP_TEXT)
  .action((opts: { limit?: number; previous: boolean }) => {
    withExitHandling(() =>
      runView({ ...(opts.limit !== undefined ? { limit: opts.limit } : {}), previous: opts.previous })
    );
  });

program
  .command("send [to]")
  .description(
    'Compose and send one new email, e.g. gmail send "someone@example.com" — shares gmail view\'s exact ' +
      "compose/AI-draft/confirm flow; nothing sends without a final exact-message confirmation"
  )
  .option("--subject <text>", "subject line (skips the prompt)")
  .option("--ai", "draft the body with AI using your saved writing style, instead of typing it manually", false)
  .action((to: string | undefined, opts: { subject?: string; ai: boolean }) => {
    withExitHandling(() =>
      runSend({
        ...(to !== undefined ? { to } : {}),
        ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
        ai: opts.ai
      })
    );
  });

program
  .command("help [command]")
  .description("Show all commands and Gmail view controls, or focused help for one command")
  .action((commandName?: string) => {
    if (commandName === undefined) {
      program.outputHelp();
      return;
    }
    const command = program.commands.find((candidate) => candidate.name() === commandName);
    if (!command) {
      console.error(pc.red(`Unknown command: ${commandName}`));
      console.error("Run 'gmail help' to see available commands.");
      process.exitCode = EXIT_CODES.invalidOrAuthRequired;
      return;
    }
    command.outputHelp();
  });

// Commander's root `.action()` absorbs ANY unrecognized first argument as
// if it were plain `gmail` with no subcommand — so `gmail spam "x"` (a
// plausible typo for `gmail add spam "x"`) or any other typo would
// otherwise silently run the full mutating pipeline instead of erroring.
// Since bare `gmail` performs real mailbox mutations, that's a dangerous
// default; check the first token explicitly before letting Commander parse.
const KNOWN_SUBCOMMANDS = new Set(["add", "category", "cache", "uncache", "view", "send", "help"]);
const firstArg = process.argv[2];
if (firstArg !== undefined && !firstArg.startsWith("-") && !KNOWN_SUBCOMMANDS.has(firstArg)) {
  console.error(pc.red(`Unknown command: ${firstArg}`));
  console.error("Run 'gmail help' to see available commands.");
  process.exitCode = EXIT_CODES.invalidOrAuthRequired;
} else {
  program.parse();
}
