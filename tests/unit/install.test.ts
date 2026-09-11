import { afterEach, describe, expect, it, vi } from "vitest";
import { runInstall } from "../../src/commands/install.js";
import { EXIT_CODES } from "../../src/core/errors.js";
import { COMMANDS } from "../../src/docs/command-reference.js";

const originalIsTTY = process.stdin.isTTY;

afterEach(() => {
  process.stdin.isTTY = originalIsTTY;
  vi.restoreAllMocks();
});

describe("runInstall", () => {
  it("fails safe instead of crashing inside a prompt when there is no terminal to answer it", async () => {
    process.stdin.isTTY = false;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runInstall()).resolves.toBe(EXIT_CODES.safetyBlocked);
    // Every step of the wizard is a question; a non-interactive caller needs
    // to be told the unattended path rather than shown a TTY stack trace.
    expect(errors.mock.calls.flat().join(" ")).toContain("GMAIL_AGENT_OAUTH_CLIENT_ID");
  });
});

describe("command reference", () => {
  it("documents gmail install, since it is the first command a new user runs", () => {
    const install = COMMANDS.find((command) => command.name === "gmail install");
    expect(install).toBeDefined();
    // The wizard must never be the thing that first changes a mailbox.
    expect(install!.confirmation).toContain("dry run");
    expect(install!.sideEffects).toContain("changes nothing");
  });
});
