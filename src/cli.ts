#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { runWork } from "./commands/work.js";
import { runSpam } from "./commands/spam.js";
import { runImportant } from "./commands/important.js";
import { rulesList, rulesRemove } from "./commands/rules.js";
import { runSummary } from "./commands/summary.js";
import { runUndo } from "./commands/undo.js";
import { authLogin, authLogout, authStatus } from "./commands/auth.js";
import { configShow } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { GmailAgentError, EXIT_CODES } from "./core/errors.js";

const program = new Command();

program
  .name("gmail")
  .description("Local terminal agent that cleans up Gmail and creates Calendar events from actionable mail.")
  .version("0.1.0");

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

program
  .command("work")
  .description("Scan and clean up the mailbox (default command)")
  .option("--dry-run", "preview without making changes", false)
  .option("--json", "emit a single JSON summary to stdout", false)
  .action((opts: { dryRun: boolean; json: boolean }) => {
    withExitHandling(() => runWork({ dryRun: opts.dryRun, json: opts.json }));
  });

program
  .command("spam [category]")
  .description("Create/apply a spam category and attempt unsubscribe")
  .option("--yes", "authorize the narrow rule and current-message trash", false)
  .option("--all-mail", "also trash matches in archived mail", false)
  .option("--allow-mailto", "authorize sending a confirmed mailto: unsubscribe", false)
  .option("--retry-unsubscribe", "retry a previously attempted unsubscribe", false)
  .action((category: string | undefined, opts: { yes: boolean; allMail: boolean; allowMailto: boolean; retryUnsubscribe: boolean }) => {
    withExitHandling(() =>
      runSpam(category, {
        yes: opts.yes,
        allMail: opts.allMail,
        allowMailto: opts.allowMailto,
        retryUnsubscribe: opts.retryUnsubscribe
      })
    );
  });

program
  .command("important [category]")
  .description("Create/apply a persistent important category")
  .option("--yes", "authorize the rule and current-message star/important", false)
  .action((category: string | undefined, opts: { yes: boolean }) => {
    withExitHandling(() => runImportant(category, { yes: opts.yes }));
  });

const rules = program.command("rules").description("Manage local spam/important rules");
rules
  .command("list")
  .option("--json", "emit JSON", false)
  .action((opts: { json: boolean }) => withExitHandling(() => rulesList(opts)));
rules
  .command("remove <ruleGroupId>")
  .action((ruleGroupId: string) => withExitHandling(() => rulesRemove(ruleGroupId)));

program
  .command("summary [runId]")
  .option("--json", "emit JSON", false)
  .action((runId: string | undefined, opts: { json: boolean }) => withExitHandling(() => runSummary(runId, opts)));

program
  .command("undo <runId>")
  .option("--yes", "skip the confirmation prompt", false)
  .action((runId: string, opts: { yes: boolean }) => withExitHandling(() => runUndo(runId, opts)));

const auth = program.command("auth").description("Manage Google sign-in");
auth.command("login").action(() => withExitHandling(authLogin));
auth.command("status").action(() => withExitHandling(authStatus));
auth.command("logout").action(() => withExitHandling(authLogout));

const config = program.command("config").description("Show resolved configuration");
config.command("show").action(() => withExitHandling(configShow));

program.command("doctor").description("Run read-only diagnostics").action(() => withExitHandling(runDoctor));

// `gmail` with no subcommand is exactly `gmail work`.
if (process.argv.length <= 2) {
  withExitHandling(() => runWork({ dryRun: false, json: false }));
} else {
  program.parse();
}
