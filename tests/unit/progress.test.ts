import { afterEach, describe, expect, it, vi } from "vitest";
import { createClassifierProgress, createReadProgress } from "../../src/commands/progress.js";

function capture(isTTY = false) {
  const writes: string[] = [];
  return { writes, output: { isTTY, write: (text: string) => { writes.push(text); } } };
}

afterEach(() => vi.useRealTimers());

describe("read progress display", () => {
  it("reports intermediate counts in redirected output without one line per message", () => {
    const { writes, output } = capture();
    const progress = createReadProgress({ output });
    progress.onPhase("discovering");
    progress.onProgress(500);
    progress.onPhase("hydrating", 200);
    for (let i = 1; i <= 200; i++) progress.onProgress(i, 200, i === 200 ? 2 : 0);
    progress.onFinish(false);
    const text = writes.join("");
    expect(text).toContain("500 found");
    expect(text).toContain("100/200");
    expect(text).toContain("2 failed");
    expect(text).toContain("Stopped with errors");
    expect(text).not.toMatch(/[\r\u001b]/);
    expect(writes.length).toBeLessThan(20);
  });

  it("keeps JSON-mode stderr plain even on a terminal and coalesces concurrent quota waits", () => {
    const { writes, output } = capture(true);
    const progress = createReadProgress({ output, interactive: false, now: () => 0 });
    progress.onPhase("hydrating", 50);
    for (let i = 0; i < 8; i++) progress.onQuotaWait(10_000);
    progress.onProgress(25, 50);
    progress.onFinish();
    expect(writes.join("")).not.toMatch(/[\r\u001b]/);
    expect(writes.filter((line) => line.includes("Gmail quota cooldown"))).toHaveLength(2);
    expect(writes).toHaveLength(4);
  });

  it("refreshes elapsed time and quota countdown during stalled reads and stops its timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { writes, output } = capture(true);
    const progress = createReadProgress({ output });
    progress.onPhase("hydrating", 100);
    progress.onProgress(35, 100);
    progress.onQuotaWait(10_000);
    vi.advanceTimersByTime(2000);
    expect(writes.at(-1)).toContain("Gmail quota cooldown 8s");
    expect(writes.at(-1)).toContain("2s elapsed");
    progress.onFinish(false);
    const count = writes.length;
    vi.advanceTimersByTime(5000);
    progress.onFinish(false);
    expect(writes).toHaveLength(count);
    expect(writes.at(-1)).toBe("\n");
    expect(writes.at(-2)).toContain("35%");
  });

  it("ends a terminal line before another message and can restart for reconciliation", () => {
    const { writes, output } = capture(true);
    const progress = createReadProgress({ output });
    progress.onPhase("preparing");
    progress.writeMessage("A status message");
    expect(writes.at(-2)).toBe("\n");
    expect(writes.at(-1)).toBe("A status message\n");
    progress.onFinish();
    progress.onPhase("reconciling", 0);
    progress.onFinish();
    expect(writes.join("")).toContain("100% Reconciling mailbox changes");
  });
});

it("keeps classifier progress advancing in noninteractive output", () => {
  const { writes, output } = capture();
  const progress = createClassifierProgress({ output });
  progress.onStart(100);
  for (let i = 1; i <= 100; i++) progress.onProgress(i, 100);
  progress.onFinish();
  expect(writes.join("")).toContain("50/100");
  expect(writes).toHaveLength(12);
});
