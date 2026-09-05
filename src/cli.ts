#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { runWork } from "./commands/work.js";
import { runAdd } from "./commands/add.js";
import { runCategory } from "./commands/category.js";
import { GmailAgentError, EXIT_CODES } from "./core/errors.js";

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive whole number.");
  }
  return parsed;
}

// MVP command surface: `gmail` (scan + clean up, with inline sign-in on
// first run), `gmail add` (create a spam/important rule), and
// `gmail category` (create a Gmail label directly, on demand). The other
// commands (spam/important/rules/summary/undo/auth/config/doctor) still
// exist as working code under src/commands/ — they're just not wired up
// as CLI subcommands yet. Re-add them here when they're back in scope.

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
      console.error(pc.red(error instanceof Error ? error.stack ?? error.message : String(error)));
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

// Commander's root `.action()` absorbs ANY unrecognized first argument as
// if it were plain `gmail` with no subcommand — so `gmail spam "x"` (a
// plausible typo for `gmail add spam "x"`) or any other typo would
// otherwise silently run the full mutating pipeline instead of erroring.
// Since bare `gmail` performs real mailbox mutations, that's a dangerous
// default; check the first token explicitly before letting Commander parse.
const KNOWN_SUBCOMMANDS = new Set(["add", "category", "help"]);
const firstArg = process.argv[2];
if (firstArg !== undefined && !firstArg.startsWith("-") && !KNOWN_SUBCOMMANDS.has(firstArg)) {
  console.error(pc.red(`Unknown command: ${firstArg}`));
  console.error("Run 'gmail --help' to see available commands.");
  process.exitCode = EXIT_CODES.invalidOrAuthRequired;
} else {
  program.parse();
}
