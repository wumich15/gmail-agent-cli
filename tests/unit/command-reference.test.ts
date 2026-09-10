import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COMMANDS, VIEW_CONTROLS, renderViewControlsHelp } from "../../src/docs/command-reference.js";

/**
 * The reference is what `gmail help` prints, what the browser Commands view
 * renders, and what docs/commands.md documents. These tests exist so that
 * adding or removing a command cannot leave one of those three stale — the
 * failure mode the plan explicitly calls out.
 */

function registeredCliCommands(): string[] {
  const source = readFileSync("src/cli.ts", "utf-8");
  const names = [...source.matchAll(/\.command\("([a-z]+)[\s"<[]/g)].map((match) => match[1]!);
  return [...new Set(names)];
}

describe("command reference", () => {
  it("documents exactly the commands that are actually wired into the CLI", () => {
    const documented = COMMANDS.map((command) => command.name.replace(/^gmail ?/, "")).filter((name) => name !== "");
    const registered = registeredCliCommands();
    expect([...documented].sort()).toEqual([...registered].sort());
  });

  it("documents the bare `gmail` command, which is the one most people run first", () => {
    expect(COMMANDS.some((command) => command.name === "gmail")).toBe(true);
  });

  it("states what every command changes and what it confirms, so no side effect is undocumented", () => {
    for (const command of COMMANDS) {
      expect(command.sideEffects.length).toBeGreaterThan(0);
      expect(command.confirmation.length).toBeGreaterThan(0);
      expect(command.summary.length).toBeGreaterThan(0);
    }
  });

  it("renders terminal help from the same data the web reference uses", () => {
    const help = renderViewControlsHelp();
    for (const control of VIEW_CONTROLS) {
      expect(help).toContain(control.keys);
      expect(help).toContain(control.description);
    }
  });

  it("keeps docs/commands.md listing every documented command", () => {
    const markdown = readFileSync("docs/commands.md", "utf-8");
    for (const command of COMMANDS) {
      expect(markdown).toContain(command.name);
    }
  });
});
