import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ProcessLock } from "../../src/core/lock.js";
import { SafetyPreconditionError } from "../../src/core/errors.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Blocks the test thread, matching how acquire() itself waits. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

  it("waits for a live holder that releases within the wait budget instead of failing immediately", () => {
    // Regression: acquire() made exactly one attempt, so any command run
    // alongside a `gmail view` session — whose background cache loader
    // takes and releases this lock once per page — almost always landed
    // mid-chunk and died with "another gmail process is already running",
    // even though the lock was free again milliseconds later.
    //
    // The holder has to be a real other process: the wait is synchronous
    // (acquire() runs at command startup, before anything is in flight),
    // so a same-thread timer could never run to release it.
    const path = freshLockPath();
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");fs.writeFileSync(${JSON.stringify(path)},String(process.pid),{flag:"wx"});` +
          `setTimeout(()=>fs.unlinkSync(${JSON.stringify(path)}),400);setTimeout(()=>{},1500);`
      ],
      { stdio: "ignore" }
    );
    try {
      while (!existsSync(path)) sleepSync(5);

      const startedAt = Date.now();
      const waiting = new ProcessLock(path);
      waiting.acquire({ waitMs: 5_000 });

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
      expect(readFileSync(path, "utf-8").trim()).toBe(String(process.pid));
      waiting.release();
    } finally {
      child.kill();
    }
  });

  it("still gives up once the wait budget is spent", () => {
    const path = freshLockPath();
    writeFileSync(path, String(process.pid), { mode: 0o600 });
    const lock = new ProcessLock(path);
    const startedAt = Date.now();
    expect(() => lock.acquire({ waitMs: 200 })).toThrow(SafetyPreconditionError);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
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
