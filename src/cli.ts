#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { runWork } from "./commands/work.js";
import { runAdd } from "./commands/add.js";
import { GmailAgentError, EXIT_CODES } from "./core/errors.js";

// MVP command surface: just `gmail` (scan + clean up, with inline sign-in
// on first run) and `gmail add` (create a spam/important rule). The other
// commands (spam/important/rules/summary/undo/auth/config/doctor) still
// exist as working code under src/commands/ — they're just not wired up
// as CLI subcommands yet. Re-add them here when they're back in scope.

const program = new Command();

program
  .name("gmail")
  .description("Local terminal agent that cleans up Gmail and creates Calendar events from actionable mail.")
  .version("0.1.0")
  .option("--dry-run", "preview without making changes", false)
  .option("--json", "emit a single JSON summary to stdout", false);

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

program.action((opts: { dryRun: boolean; json: boolean }) => {
  withExitHandling(() => runWork({ dryRun: opts.dryRun, json: opts.json }));
});

program
  .command("add <type> [category]")
  .description('Add a rule: "gmail add spam <category>" or "gmail add important <category>"')
  .option("--yes", "authorize the rule and its immediate current-message actions", false)
  .action((type: string, category: string | undefined, opts: { yes: boolean }) => {
    withExitHandling(() => runAdd(type, category, { yes: opts.yes }));
  });

// Commander's root `.action()` absorbs ANY unrecognized first argument as
// if it were plain `gmail` with no subcommand — so `gmail spam "x"` (a
// plausible typo for `gmail add spam "x"`) or any other typo would
// otherwise silently run the full mutating pipeline instead of erroring.
// Since bare `gmail` performs real mailbox mutations, that's a dangerous
// default; check the first token explicitly before letting Commander parse.
const KNOWN_SUBCOMMANDS = new Set(["add", "help"]);
const firstArg = process.argv[2];
if (firstArg !== undefined && !firstArg.startsWith("-") && !KNOWN_SUBCOMMANDS.has(firstArg)) {
  console.error(pc.red(`Unknown command: ${firstArg}`));
  console.error("Run 'gmail --help' to see available commands.");
  process.exitCode = EXIT_CODES.invalidOrAuthRequired;
} else {
  program.parse();
}
