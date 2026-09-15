import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SafetyPreconditionError } from "./errors.js";

/**
 * Whether `pid` is still running.
 *
 * Only `ESRCH` ("no such process") is conclusive evidence that the holder
 * is gone. `process.kill(pid, 0)` also throws `EPERM` when the process
 * exists but belongs to another user, and reading that as "dead" would let
 * `acquire()` delete a live holder's lock file and hand the same account to
 * two commands at once — the single failure this lock exists to prevent.
 * Anything unrecognized is likewise treated as "still alive", because
 * refusing to start is recoverable and double-mutating a mailbox is not.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code !== "ESRCH";
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
 * Blocks this thread for `ms`.
 *
 * Only `acquire()` uses this, and only for a command that has nothing else
 * in flight: it runs at startup, before any async work exists, so parking
 * the event loop costs nothing. Anything already running concurrently —
 * the interactive viewer's foreground actions, an outbound send inside a
 * live session — must use `acquireAsync()` instead, because freezing the
 * loop there also freezes that process's own in-flight Gmail reads and
 * their abort signals while they tick towards their timeouts.
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
  private blockingPid: number | null = null;

  constructor(private readonly path: string) {}

  /**
   * Blocking acquire, for a command that has no other work in flight.
   *
   * `waitMs` bounds how long to keep retrying while a *live* process holds
   * the lock; it defaults to 0 (fail immediately). Prefer `acquireAsync()`
   * whenever the caller already has asynchronous work running.
   */
  acquire(options: { waitMs?: number } = {}): void {
    this.prepareDirectory();
    const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
    for (;;) {
      if (this.attempt()) return;
      if (Date.now() >= deadline) throw this.heldError();
      sleepSync(LOCK_POLL_INTERVAL_MS);
    }
  }

  /**
   * The same acquire, waiting on a timer instead of on the event loop.
   *
   * Identical semantics to `acquire()`, including `waitMs: 0` making
   * exactly one attempt and never yielding. Used everywhere the process is
   * already doing something — `gmail view`'s per-operation lock and the
   * outbound send path — where a synchronous wait would stall the caller's
   * own in-flight requests for the length of the wait.
   */
  async acquireAsync(options: { waitMs?: number } = {}): Promise<void> {
    this.prepareDirectory();
    const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
    for (;;) {
      if (this.attempt()) return;
      if (Date.now() >= deadline) throw this.heldError();
      await delay(LOCK_POLL_INTERVAL_MS);
    }
  }

  /**
   * Removes the lock file, but only while it still names this process.
   *
   * The unconditional unlink this replaced could delete a *different*
   * process's lock: if our file were ever reclaimed as stale (a recycled
   * PID, or the `EPERM` misreading fixed above), the new holder's file sits
   * at the same path, and releasing would silently free an account another
   * command believes it owns.
   */
  release(): void {
    if (!this.acquired) return;
    this.acquired = false;
    let holder: string;
    try {
      holder = readFileSync(this.path, "utf-8").trim();
    } catch {
      // Already gone; nothing of ours left to remove.
      return;
    }
    if (holder !== String(process.pid)) return;
    try {
      unlinkSync(this.path);
    } catch {
      // Raced with an external cleanup; the file is gone either way.
    }
  }

  private prepareDirectory(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * One non-blocking acquisition attempt.
   *
   * Uses an atomic exclusive-create write (`flag: "wx"`) rather than a
   * separate existence check followed by a write — the two-step version
   * has a TOCTOU race where two processes launched close together can
   * both observe "no lock file" and both proceed to write one, defeating
   * the whole point of an exclusive lock. On EEXIST, checks whether the
   * PID that holds the file is still alive; a stale lock from a crashed
   * process is removed and the atomic create retried. Returns false only
   * when a genuinely live process holds it.
   */
  private attempt(): boolean {
    const pidContent = String(process.pid);
    for (;;) {
      try {
        writeFileSync(this.path, pidContent, { mode: 0o600, flag: "wx" });
        this.acquired = true;
        this.blockingPid = null;
        return true;
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
        // A positive integer only. An empty or corrupt lock file parses to
        // 0 or NaN, and 0 is not a harmless value to pass to
        // `process.kill`: on POSIX it addresses the caller's whole process
        // group, so it would report "alive" (now that EPERM means alive)
        // and wedge the account behind a lock file that names nobody.
        // Garbage is stale by definition; reclaim it.
        if (Number.isInteger(existingPid) && (existingPid as number) > 0 && isProcessAlive(existingPid)) {
          this.blockingPid = existingPid;
          return false;
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

  private heldError(): SafetyPreconditionError {
    return new SafetyPreconditionError(
      `Another gmail process (pid ${this.blockingPid ?? "unknown"}) is already running for this account. ` +
        "Wait for it to finish, or if it crashed, remove the lock file manually: " +
        this.path
    );
  }
}
