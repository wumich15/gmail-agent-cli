import { describe, expect, it, afterEach } from "vitest";
import { runSend } from "../../src/commands/send.js";
import { EXIT_CODES } from "../../src/core/errors.js";

describe("runSend", () => {
  const originalIsTTY = process.stdin.isTTY;
  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  it("fails safe instead of guessing when stdin is not a TTY", async () => {
    // gmail send always ends at an interactive exact-message confirmation
    // (see gmail/compose-flow.ts), so a non-interactive invocation must
    // refuse rather than silently skip or auto-confirm that gate.
    process.stdin.isTTY = false;
    const code = await runSend({ ai: false });
    expect(code).toBe(EXIT_CODES.safetyBlocked);
  });
});
