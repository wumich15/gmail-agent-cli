#!/usr/bin/env node
/**
 * Restores the executable bit on the CLI entry point after a build.
 *
 * `tsc` writes every output file 0644, and the `bin` shim that `npm i -g`,
 * `npm link`, or `pnpm link --global` created is a symlink straight to this
 * file — so its permissions are the ones the shell actually checks. A plain
 * rebuild therefore left a linked install with `zsh: permission denied: gmail`
 * until someone chmod'd it by hand. Package managers only set that bit at
 * install time, so the build has to maintain it.
 *
 * chmod is a no-op on Windows, where executability comes from the generated
 * .cmd/.ps1 shims instead; the call is harmless there.
 */
import { chmodSync, existsSync } from "node:fs";

const entry = "dist/cli.js";
if (!existsSync(entry)) {
  console.error(`${entry} is missing — the TypeScript build did not produce it.`);
  process.exit(1);
}
chmodSync(entry, 0o755);
