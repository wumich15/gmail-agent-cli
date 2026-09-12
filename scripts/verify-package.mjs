#!/usr/bin/env node
/**
 * Package hygiene gate. Run after `pnpm build`, before publishing.
 *
 * Two questions about a published artifact:
 *
 * 1. Is it clean? No model-provider key, Google token, private key, saved
 *    OAuth client, `.env`, local database, or diagnostic log may be inside it.
 * 2. Is its publisher configuration coherent? A build is either a source build
 *    (every release marker intact, and the CLI says plainly that it has no
 *    publisher behind it) or a release build (every marker replaced with a
 *    valid HTTPS value). A half-embedded build is the dangerous case: it would
 *    claim a zero-setup onboarding path and then fail partway through it, or
 *    ship a developer's own Cloud project to every user.
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

// ------------------------------------------------- publisher configuration
const PUBLISHER_MARKERS = [
  "__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID__",
  "__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET__",
  "__GMAIL_AGENT_PUBLISHER_SETUP_PAGE_URL__",
  "__GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL__",
  "__GMAIL_AGENT_PUBLISHER_FIREBASE_API_KEY__"
];

try {
  const publisherModule = readFileSync("dist/auth/publisher-client.js", "utf8");
  const intact = PUBLISHER_MARKERS.filter((marker) => publisherModule.includes(marker));

  if (intact.length === PUBLISHER_MARKERS.length) {
    notes.push("Source build: no publisher configuration embedded (the CLI will say so)");
  } else if (intact.length > 0) {
    fail(
      `Publisher configuration is half-embedded; still unreplaced: ${intact.join(", ")}. ` +
        "Run scripts/embed-release-config.mjs, or build from a clean tree."
    );
  } else {
    // A release build. Check the values actually shipped, since this is the
    // last point before they reach every user.
    const embedded = (name) => new RegExp(`${name}\\s*=\\s*embedded\\("([^"]*)"\\)`).exec(publisherModule)?.[1];
    const clientId = embedded("PUBLISHER_OAUTH_CLIENT_ID");
    const setupPage = embedded("PUBLISHER_SETUP_PAGE_URL");
    const gateway = embedded("PUBLISHER_AI_GATEWAY_URL");

    if (clientId && !clientId.endsWith(".apps.googleusercontent.com")) {
      fail("The embedded publisher OAuth client ID is not a Google OAuth client ID.");
    }
    for (const [name, value] of Object.entries({ "setup page": setupPage, "AI gateway": gateway })) {
      if (!value) continue;
      // http-on-loopback is allowed at runtime so the gateway can be run
      // locally during development. It must never escape into a package.
      if (!value.startsWith("https://")) fail(`The embedded ${name} URL must use HTTPS in a release build.`);
      if (/127\.0\.0\.1|localhost|\[::1\]/.test(value)) fail(`The embedded ${name} URL points at loopback.`);
    }
    notes.push("Release build: publisher configuration embedded and well-formed");
  }
} catch {
  fail("dist/auth/publisher-client.js is missing. Run \"pnpm build\" first.");
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
    // A Firebase Web API key is a project identifier rather than a
    // credential, and a release build embeds one on purpose. Only a key
    // outside that one file is suspicious.
    { pattern: /\bAIza[0-9A-Za-z_-]{30,}/, description: "a Google API key", allowIn: ["dist/auth/publisher-client.js"] },
    { pattern: /\bsk-or-[A-Za-z0-9_-]{20,}/, description: "an OpenRouter API key" }
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
    for (const { pattern, description, allowIn } of forbiddenContent) {
      if (allowIn?.includes(relativePath)) continue;
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
console.log(
  "\nPackage verified: no provider credentials or development state inside it, and its publisher configuration is coherent."
);
