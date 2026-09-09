import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf-8"
  });
}

describe("gmail help", () => {
  it("prints every top-level command and the complete view controls without running mailbox work", () => {
    const result = runCli("help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("view [options]");
    expect(result.stdout).toContain("Gmail view controls:");
    expect(result.stdout).toContain("r / ;r");
    expect(result.stderr).toBe("");
  });

  it("supports focused view help with the shared controls and options", () => {
    const result = runCli("help", "view");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--previous");
    expect(result.stdout).toContain("Gmail view controls:");
  });
});
