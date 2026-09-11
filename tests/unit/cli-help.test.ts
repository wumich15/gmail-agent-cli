import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf-8"
  });
}

function stripNodeWarnings(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !/^\(node:\d+\)/.test(line) && !/^\(Use `node --trace-/.test(line))
    .join("\n")
    .trim();
}

describe("gmail help", () => {
  it("prints every top-level command and the complete view controls without running mailbox work", () => {
    const result = runCli("help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("view [options]");
    expect(result.stdout).toContain("send [options]");
    expect(result.stdout).toContain("Gmail view controls:");
    expect(result.stdout).toContain("r / ;r");
    expect(result.stdout).toContain("type email number to open");
    expect(result.stdout).toContain("open one of this message's links in your system browser");
    // The point is that `help` does no mailbox work and reports no problem of
    // its own — not that the runtime is silent. Node writes its own
    // deprecation notices (e.g. DEP0040 for punycode, from a transitive
    // dependency) to stderr on some versions, which is not this CLI talking.
    expect(stripNodeWarnings(result.stderr)).toBe("");
  });

  it("supports focused view help with the shared controls and options", () => {
    const result = runCli("help", "view");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--previous");
    expect(result.stdout).toContain("Gmail view controls:");
  });
});

describe("packaging", () => {
  it("reports the package's own version, not a literal that drifts when it is bumped", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const result = runCli("--version");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it.skipIf(process.platform === "win32")(
    "declares a build that leaves the CLI entry point executable",
    () => {
      // A linked install (`npm link`, `pnpm link --global`) symlinks the
      // `gmail` shim straight at dist/cli.js, so that file's own mode is what
      // the shell checks. tsc writes 0644, and package managers only set the
      // bit at install time — without this step in the build, any rebuild
      // breaks the installed command with "permission denied".
      const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
      expect(pkg.scripts["build"]).toContain("make-executable.mjs");

      // And if a build has actually run here, the bit must really be set.
      if (existsSync("dist/cli.js")) {
        expect(statSync("dist/cli.js").mode & 0o111).not.toBe(0);
      }
    }
  );
});
