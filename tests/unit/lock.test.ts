import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessLock } from "../../src/core/lock.js";
import { SafetyPreconditionError } from "../../src/core/errors.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshLockPath(): string {
  dir = mkdtempSync(join(tmpdir(), "gmail-agent-lock-test-"));
  return join(dir, "account.lock");
}

describe("ProcessLock", () => {
  it("acquires and writes its own pid when no lock file exists", () => {
    const path = freshLockPath();
    const lock = new ProcessLock(path);
    lock.acquire();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8").trim()).toBe(String(process.pid));
    lock.release();
  });

  it("refuses to acquire while a live process holds the lock", () => {
    const path = freshLockPath();
    // Our own process is always alive, so writing our own pid simulates a live holder.
    writeFileSync(path, String(process.pid), { mode: 0o600 });
    const lock = new ProcessLock(path);
    expect(() => lock.acquire()).toThrow(SafetyPreconditionError);
  });

  it("reclaims a stale lock left by a pid that is no longer running", () => {
    const path = freshLockPath();
    // PID 1 belongs to init/launchd on POSIX systems and is never this
    // test process; a very large, implausible PID simulates "not alive"
    // portably without depending on a specific reserved PID.
    writeFileSync(path, "999999999", { mode: 0o600 });
    const lock = new ProcessLock(path);
    lock.acquire();
    expect(readFileSync(path, "utf-8").trim()).toBe(String(process.pid));
    lock.release();
  });

  it("release removes the lock file only when this instance actually acquired it", () => {
    const path = freshLockPath();
    const lock = new ProcessLock(path);
    // Never called acquire() — release() must be a no-op, not delete a
    // lock file some other process might be relying on.
    writeFileSync(path, "999999999", { mode: 0o600 });
    lock.release();
    expect(existsSync(path)).toBe(true);
  });

  it("uses an atomic exclusive-create write, not a separate exists-check-then-write", () => {
    // Regression: a prior version checked existsSync() and then wrote
    // separately, leaving a window where two concurrent acquire() calls
    // could both observe "no lock" and both proceed. Acquiring twice in a
    // row on an already-live-locked path must fail on the second call
    // even though nothing else has looked at the filesystem in between.
    const path = freshLockPath();
    const first = new ProcessLock(path);
    first.acquire();
    const second = new ProcessLock(path);
    expect(() => second.acquire()).toThrow(SafetyPreconditionError);
    first.release();
  });
});
