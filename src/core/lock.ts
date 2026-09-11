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
 * How long a command waits for a lock another live process is holding
 * before giving up.
 *
 * The lock used to be a single non-blocking attempt, which was fine when
 * every holder was a short mutating command. `gmail view` broke that
 * assumption: its background cache loader takes and releases this lock
 * once per page for as long as the session is open, so a `gmail` run
 * started alongside a view session almost always landed in one of those
 * chunks and died with "another gmail process is already running" even
 * though the lock was free again milliseconds later. Waiting a few
 * seconds turns that into a short pause instead of a hard failure, while
 * still failing fast enough to be obvious when a genuinely long run (a
 * full `gmail work`) really does own the account.
 */
export const DEFAULT_LOCK_WAIT_MS = 10_000;

/** How often a waiting acquire() re-tries the atomic create. */
const LOCK_POLL_INTERVAL_MS = 100;

/**
 * Blocks this thread for `ms`. `acquire()` is synchronous and is called at
 * command startup, before any async work is in flight, so parking the
 * event loop here costs nothing; the interactive viewer deliberately never
 * waits (it passes `waitMs: 0`) precisely because it must not stall its
 * own in-flight work.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
   *
   * `waitMs` bounds how long to keep retrying while a *live* process holds
   * the lock. It defaults to 0 (fail immediately) so callers that must not
   * block — the interactive viewer's per-operation lock — keep the old
   * behavior; ordinary commands pass `DEFAULT_LOCK_WAIT_MS` so they ride
   * out a view session's brief background cache chunks instead of
   * refusing to start.
   */
  acquire(options: { waitMs?: number } = {}): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const pidContent = String(process.pid);
    const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);

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
          // Held by something that really is running. Retry until the
          // caller's wait budget runs out; a holder that releases in the
          // meantime (a view session between cache chunks) lets us through.
          if (Date.now() < deadline) {
            sleepSync(LOCK_POLL_INTERVAL_MS);
            continue;
          }
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
