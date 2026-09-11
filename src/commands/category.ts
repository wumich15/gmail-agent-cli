import pc from "picocolors";
import { bootstrap } from "../core/bootstrap.js";
import { resolveAccount } from "./shared.js";
import { getOrCreateLabelId, listUserLabels } from "../gmail/custom-labels.js";
import { AuthRequiredError, EXIT_CODES } from "../core/errors.js";
import { DEFAULT_LOCK_WAIT_MS, ProcessLock } from "../core/lock.js";
import { lockFilePath } from "../config/paths.js";

/**
 * `gmail category <name...>` — lets the user create one or more Gmail
 * labels directly, on demand, independent of the AI-driven topical
 * labeling in `gmail`/`gmail work` (which only ever creates a label once
 * at least 10 messages in one run agree on it — see CLAUDE.md's
 * "Automatic topical labeling"). This is the explicit, no-threshold path:
 * whatever name the user gives is created (or reused if it already
 * exists, case-insensitively) immediately. It only ever creates the
 * label itself; it does not search for or relabel any existing mail —
 * pairing a freshly created category with real messages happens on the
 * next `gmail`/`gmail work` run, which will now see it in the account's
 * existing-label list and can propose it for matching mail.
 */
export async function runCategory(names: string[]): Promise<number> {
  if (names.length === 0) {
    console.error(pc.yellow('Usage: gmail category "<name>" ["<name2>" ...]'));
    return EXIT_CODES.invalidOrAuthRequired;
  }

  const ctx = bootstrap();
  let resolved;
  try {
    resolved = await resolveAccount(ctx);
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      console.error(pc.red("No account is signed in yet. Run `gmail` once first to sign in."));
      return EXIT_CODES.invalidOrAuthRequired;
    }
    throw error;
  }
  const { account, gmailClient } = resolved;

  const lock = new ProcessLock(lockFilePath(account.accountHash));
  lock.acquire({ waitMs: DEFAULT_LOCK_WAIT_MS });
  try {
    const existing = await listUserLabels(gmailClient);
    const known = new Map(existing.map((l) => [l.name.trim().toLowerCase(), l.id]));

    let failureCount = 0;
    for (const rawName of names) {
      const name = rawName.trim();
      if (name.length === 0) {
        console.error(pc.yellow('Skipping a blank category name.'));
        continue;
      }
      const alreadyExisted = known.has(name.toLowerCase());
      try {
        await getOrCreateLabelId(gmailClient, name, known);
        console.log(
          alreadyExisted
            ? pc.dim(`"${name}" already exists — nothing to do.`)
            : pc.green(`Created label "${name}".`)
        );
      } catch (error) {
        failureCount += 1;
        console.error(pc.red(`Failed to create "${name}": ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    console.log(
      "Future `gmail` runs will see these labels and can apply them to matching mail once at least 10 " +
        "messages in a single run agree on the same category."
    );
    return failureCount > 0 ? EXIT_CODES.operationalFailure : EXIT_CODES.ok;
  } finally {
    lock.release();
  }
}
