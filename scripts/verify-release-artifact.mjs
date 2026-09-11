#!/usr/bin/env node
/**
 * Release gate. Run after `pnpm build:release`, before signing or publishing.
 *
 * It answers the two questions the production plan asks of every consumer
 * artifact:
 *
 *   1. Is it actually configured? The built app must report `publisher` OAuth
 *      and gateway sources — never an unreplaced release marker, which would
 *      ship a build whose "Connect Gmail" button cannot work.
 *   2. Is it clean? No OpenAI key, Google token, developer credential, `.env`,
 *      local database, or diagnostic log may be inside the package.
 *
 * Nothing secret is printed. Values are described by shape and length only, so
 * this can run in CI logs that many people can read.
 *
 * Usage: node scripts/verify-release-artifact.mjs
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

function describeSecret(value) {
  return `${value.length} characters, ends "${value.slice(-Math.min(24, value.length))}"`;
}

// ---------------------------------------------------------------- dist checks
const publisherClientPath = "dist/auth/publisher-client.js";
let publisherSource = "";
try {
  publisherSource = readFileSync(publisherClientPath, "utf8");
} catch {
  fail(`${publisherClientPath} is missing. Run "pnpm build:release" first.`);
}

if (publisherSource) {
  const markers = [
    "__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID__",
    "__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET__",
    "__GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL__"
  ];
  for (const marker of markers) {
    if (publisherSource.includes(marker)) {
      fail(`Release marker ${marker} was never replaced; this build has no publisher configuration.`);
    }
  }

  const clientId = matchConst(publisherSource, "PUBLISHER_OAUTH_CLIENT_ID");
  const clientSecret = matchConst(publisherSource, "PUBLISHER_OAUTH_CLIENT_SECRET");
  const gatewayUrl = matchConst(publisherSource, "PUBLISHER_AI_GATEWAY_URL");

  if (!clientId?.endsWith(".apps.googleusercontent.com")) {
    fail("Embedded OAuth client ID is missing or is not a Google client ID.");
  } else {
    notes.push(`OAuth client source: publisher (${describeSecret(clientId)})`);
  }
  if (!clientSecret) {
    fail("Embedded OAuth client secret is missing.");
  } else {
    notes.push(`OAuth client secret: present (${clientSecret.length} characters, never printed)`);
  }
  if (!gatewayUrl || !gatewayUrl.startsWith("https://")) {
    fail("Embedded AI gateway URL is missing or is not HTTPS.");
  } else {
    notes.push(`AI gateway source: publisher (${new URL(gatewayUrl).host})`);
  }
}

/**
 * Reads one embedded value out of the compiled file. The release build
 * substitutes the marker *constants* (`..._MARKER = "..."`), which the exported
 * constants then read, so this looks at the marker declaration rather than the
 * export.
 */
function matchConst(source, name) {
  const match = source.match(new RegExp(`${name}_MARKER\\s*=\\s*(["'])(.*?)\\1`, "s"));
  const value = match?.[2] ?? null;
  // An unreplaced marker is an absent value, not a 45-character secret.
  return value?.startsWith("__GMAIL_AGENT_PUBLISHER_") ? null : value;
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
    {
      pattern: /__GMAIL_AGENT_PUBLISHER_[A-Z_]+__/,
      description: "an unreplaced release marker",
      skipSourceMaps: true
    }
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
    for (const { pattern, description, skipSourceMaps } of forbiddenContent) {
      // A source map embeds the original TypeScript, which is marker-only by
      // design, so an unreplaced marker there is expected rather than a build
      // that forgot its configuration. Credential patterns still apply to maps.
      if (skipSourceMaps && relativePath.endsWith(".map")) continue;
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
  console.error("\nRelease artifact verification failed:");
  for (const failure of failures) console.error(`  !!  ${failure}`);
  process.exit(1);
}
console.log("\nRelease artifact verified: publisher-configured and free of credentials or development state.");
