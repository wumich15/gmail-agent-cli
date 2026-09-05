import pc from "picocolors";
import { runSpam } from "./spam.js";
import { runImportant } from "./important.js";
import { AuthRequiredError, EXIT_CODES } from "../core/errors.js";

export interface AddOptions {
  yes: boolean;
}

const RULE_TYPES = ["spam", "important"] as const;
type RuleType = (typeof RULE_TYPES)[number];

function isRuleType(value: string): value is RuleType {
  return (RULE_TYPES as readonly string[]).includes(value);
}

/**
 * `gmail add <type> <category>` — a single entry point over the
 * spam/important rule-creation logic, e.g.:
 *   gmail add spam "LinkedIn"
 *   gmail add important "Boss"
 */
export async function runAdd(type: string, category: string | undefined, options: AddOptions): Promise<number> {
  if (!isRuleType(type)) {
    console.error(pc.red(`Unknown rule type "${type}". Expected one of: ${RULE_TYPES.join(", ")}.`));
    return EXIT_CODES.invalidOrAuthRequired;
  }

  try {
    if (type === "spam") {
      return await runSpam(category, {
        yes: options.yes,
        allMail: false,
        allowMailto: false,
        retryUnsubscribe: false
      });
    }
    return await runImportant(category, { yes: options.yes });
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      console.error(pc.red("No account is signed in yet. Run `gmail` once first to sign in."));
      return EXIT_CODES.invalidOrAuthRequired;
    }
    throw error;
  }
}
