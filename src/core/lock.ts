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

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
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

  /**
   * Uses an atomic exclusive-create write (`flag: "wx"`) rather than a
   * separate existence check followed by a write — the two-step version
   * has a TOCTOU race where two processes launched close together can
   * both observe "no lock file" and both proceed to write one, defeating
   * the whole point of an exclusive lock. On EEXIST, checks whether the
   * PID that holds the file is still alive; a stale lock from a crashed
   * process is removed and the atomic create retried.
   */
  acquire(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const pidContent = String(process.pid);

    for (;;) {
      try {
        writeFileSync(this.path, pidContent, { mode: 0o600, flag: "wx" });
        this.acquired = true;
        return;
      } catch (error) {
        if (!isEexist(error)) {
          throw error;
        }
        let existingPid: number | null = null;
        try {
          existingPid = Number(readFileSync(this.path, "utf-8").trim());
        } catch {
          // Removed between our failed create and this read; loop and
          // retry the atomic create immediately.
          continue;
        }
        if (Number.isFinite(existingPid) && isProcessAlive(existingPid)) {
          throw new SafetyPreconditionError(
            `Another gmail process (pid ${existingPid}) is already running for this account. ` +
              "Wait for it to finish, or if it crashed, remove the lock file manually: " +
              this.path
          );
        }
        // Stale lock from a crashed process; remove it and retry the
        // atomic create. If another process wins this same race, its
        // create succeeds and ours fails EEXIST again, looping safely.
        try {
          unlinkSync(this.path);
        } catch {
          // Another process may have already cleaned it up; loop and
          // retry the create regardless.
        }
      }
    }
  }

  release(): void {
    if (this.acquired && existsSync(this.path)) {
      unlinkSync(this.path);
    }
    this.acquired = false;
  }
}
