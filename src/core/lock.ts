import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafetyPreconditionError } from "./errors.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A simple exclusive per-account process lock backed by a PID file. Held
 * from before the first snapshot/state write through the final ledger
 * commit for any command that can mutate Gmail, Calendar, rules,
 * credentials, migrations, or undo state.
 */
export class ProcessLock {
  private acquired = false;

  constructor(private readonly path: string) {}

  acquire(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (existsSync(this.path)) {
      const existingPid = Number(readFileSync(this.path, "utf-8").trim());
      if (Number.isFinite(existingPid) && isProcessAlive(existingPid)) {
        throw new SafetyPreconditionError(
          `Another gmail process (pid ${existingPid}) is already running for this account. ` +
            "Wait for it to finish, or if it crashed, remove the lock file manually: " +
            this.path
        );
      }
      // Stale lock from a crashed process; safe to reclaim.
    }
    writeFileSync(this.path, String(process.pid), { mode: 0o600 });
    this.acquired = true;
  }

  release(): void {
    if (this.acquired && existsSync(this.path)) {
      unlinkSync(this.path);
    }
    this.acquired = false;
  }
}
