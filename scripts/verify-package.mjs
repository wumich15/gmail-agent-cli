#!/usr/bin/env node
/**
 * Package hygiene gate. Run after `pnpm build`, before publishing.
 *
 * This tool has no publisher configuration to embed — every user signs in
 * with their own Google client and pays their own AI provider — so the only
 * question left for a published artifact is whether it is clean: no OpenAI
 * key, Google token, private key, saved OAuth client, `.env`, local database,
 * or diagnostic log may be inside the package.
 *
 * Usage: node scripts/verify-package.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

// ---------------------------------------------------------------- dist checks
try {
  readFileSync("dist/cli.js", "utf8");
} catch {
  fail("dist/cli.js is missing. Run \"pnpm build\" first.");
}

// ------------------------------------------------------------ package checks
const stagingDir = mkdtempSync(join(tmpdir(), "gmail-agent-release-"));
try {
  // stderr is captured rather than inherited: `npm pack` prints its whole file
  // listing there, which would bury the verification result in a CI log.
  const packOutput = execFileSync("npm", ["pack", "--pack-destination", stagingDir, "--silent"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_ignore_scripts: "true" }
  });
  const tarball = join(stagingDir, packOutput.trim().split("\n").pop().trim());
  execFileSync("tar", ["-xzf", tarball, "-C", stagingDir]);
  const packageRoot = join(stagingDir, "package");

  const forbiddenPath = [
    /(^|\/)\.env(\.|$)/,
    /\.sqlite(-wal|-shm|-journal)?$/,
    /\.log$/,
    /(^|\/)credentials\.json$/,
    /(^|\/)google-oauth-client\.json$/,
    /(^|\/)client_secret.*\.json$/,
    /(^|\/)\.git(\/|$)/,
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)data(\/|$)/
  ];
  const forbiddenContent = [
    { pattern: /\bsk-[A-Za-z0-9_-]{20,}/, description: "an OpenAI API key" },
    { pattern: /\bya29\.[A-Za-z0-9._-]{20,}/, description: "a Google access token" },
    { pattern: /\b1\/\/[A-Za-z0-9._-]{30,}/, description: "a Google refresh token" },
    { pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, description: "a private key" },
    { pattern: /\bAIza[0-9A-Za-z_-]{30,}/, description: "a Google API key" }
  ];

  let fileCount = 0;
  for (const file of walk(packageRoot)) {
    const relativePath = relative(packageRoot, file).split(sep).join("/");
    fileCount += 1;
    if (forbiddenPath.some((pattern) => pattern.test(relativePath))) {
      fail(`Package contains a file that must never ship: ${relativePath}`);
      continue;
    }
    if (statSync(file).size > 4 * 1024 * 1024) continue;
    const contents = readFileSync(file, "utf8");
    for (const { pattern, description } of forbiddenContent) {
      if (pattern.test(contents)) fail(`Package file ${relativePath} looks like it contains ${description}.`);
    }
  }
  notes.push(`Package contents inspected: ${fileCount} files`);
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

// -------------------------------------------------------------------- report
for (const note of notes) console.log(`  ok  ${note}`);
if (failures.length > 0) {
  console.error("\nPackage verification failed:");
  for (const failure of failures) console.error(`  !!  ${failure}`);
  process.exit(1);
}
console.log("\nPackage verified: no credentials, saved OAuth client, or development state inside it.");
