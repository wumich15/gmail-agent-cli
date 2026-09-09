import { Writable } from "node:stream";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { startRunDiagnostics } from "../../src/logging/run-diagnostics.js";
import { withGoogleApiRetry } from "../../src/core/api-retry.js";

it("persists correlated phase/attempt/heartbeat records without raw provider content", async () => {
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const log = pino({}, sink);
  vi.useFakeTimers();
  const diagnostics = startRunDiagnostics(log, "work", 100);
  try {
    diagnostics.phase("scan");
    const error = Object.assign(new Error("Too many concurrent requests: PRIVATE_MESSAGE Bearer secret"), { status: 429 });
    const failure = withGoogleApiRetry(async () => { throw error; }, { maxAttempts: 1, maxDelayMs: 0 }, 1, "gmail.messages.get.full");
    const assertion = expect(failure).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    diagnostics.phase("checkpoint");
  } finally {
    diagnostics.finish();
    vi.useRealTimers();
  }
  const rows = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(new Set(rows.map((row) => row["diagnosticRunId"])).size).toBe(1);
  expect(rows.find((row) => row["stage"] === "failed")).toMatchObject({
    operation: "gmail.messages.get.full", status: 429, errorClass: "quota", quotaReason: "concurrent_requests", attempt: 1
  });
  expect(rows.map((row) => row["msg"])).toContain("run_heartbeat");
  expect(rows.at(-1)?.["msg"]).toBe("run_diagnostics_finished");
  expect(output).not.toMatch(/PRIVATE_MESSAGE|Bearer|secret/);
});
