import pc from "picocolors";
import { runSpam } from "./spam.js";
import { runImportant } from "./important.js";
import { AuthRequiredError, GmailAgentError, EXIT_CODES } from "../core/errors.js";

export interface AddOptions {
  yes: boolean;
}

const RULE_TYPES = ["spam", "important"] as const;
type RuleType = (typeof RULE_TYPES)[number];

function isRuleType(value: string): value is RuleType {
  return (RULE_TYPES as readonly string[]).includes(value);
}

/**
 * `gmail add <type> <category...>` — a single entry point over the
 * spam/important rule-creation logic, accepting one or more categories in
 * a single invocation, e.g.:
 *   gmail add spam "LinkedIn"
 *   gmail add spam "LinkedIn" "NYT" "Amazon"
 *   gmail add important "Boss"
 *
 * Each category is handled as its own independent rule creation — one
 * category failing (a conflict, no matches, etc.) does not stop the rest
 * from being attempted, matching this app's "continue independent actions
 * after an isolated failure" approach everywhere else.
 */
export async function runAdd(type: string, categories: string[], options: AddOptions): Promise<number> {
  if (!isRuleType(type)) {
    console.error(pc.red(`Unknown rule type "${type}". Expected one of: ${RULE_TYPES.join(", ")}.`));
    return EXIT_CODES.invalidOrAuthRequired;
  }

  if (categories.length === 0) {
    return runOne(type, undefined, options);
  }

  let worstExitCode: number = EXIT_CODES.ok;
  for (const [i, category] of categories.entries()) {
    if (categories.length > 1) {
      console.log(pc.bold(`\n--- ${category} (${i + 1}/${categories.length}) ---`));
    }
    const exitCode = await runOne(type, category, options);
    if (exitCode !== EXIT_CODES.ok) {
      worstExitCode = exitCode;
    }
  }
  return worstExitCode;
}

async function runOne(type: RuleType, category: string | undefined, options: AddOptions): Promise<number> {
  try {
    if (type === "spam") {
      return await runSpam(category, {
        yes: options.yes,
        allMail: false,
        allowMailto: false,
        retryUnsubscribe: false,
        overrideImportant: true
      });
    }
    return await runImportant(category, { yes: options.yes });
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      console.error(pc.red("No account is signed in yet. Run `gmail` once first to sign in."));
      return EXIT_CODES.invalidOrAuthRequired;
    }
    // Any other *expected* failure mode this app raises as a typed error
    // (a rule conflict, a safety-blocked confirmation, etc.) must not
    // abort the whole multi-category loop above it — only a truly
    // unexpected exception (not one of this app's own typed errors)
    // should stop everything, since that's a bug rather than an expected
    // per-category outcome.
    if (error instanceof GmailAgentError) {
      console.error(pc.red(error.message));
      return error.exitCode;
    }
    throw error;
  }
}
