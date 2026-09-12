#!/usr/bin/env node
/**
 * Release gate for the hosted setup and policy site.
 *
 * The pages in `hosting/` ship with bracketed placeholders for the things only
 * the publisher can fill in: legal identity, contacts, the model service,
 * regions, retention periods, jurisdiction. Those placeholders are correct in
 * the repository and unacceptable in production — a consent screen or privacy
 * policy that says "[Publisher]" is a disclosure nobody can act on, attached
 * to a real authorization to read someone's mail.
 *
 * This check is therefore run before deploying Hosting, not on every build.
 *
 * Usage: node scripts/verify-hosting.mjs [directory]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? "hosting";
const failures = [];

/** Required pages, from the documented page map. A missing policy URL breaks OAuth verification. */
const REQUIRED_PAGES = [
  "index.html",
  "connect.html",
  "success.html",
  "error.html",
  "privacy.html",
  "terms.html",
  "data-deletion.html",
  "security.html",
  "support.html"
];

for (const page of REQUIRED_PAGES) {
  try {
    statSync(join(root, page));
  } catch {
    failures.push(`Missing required page: ${page}`);
  }
}

const PLACEHOLDER = /\[[A-Z][^\]\n]{2,60}\]/g;

/**
 * Third-party resources are blocked by the site's Content-Security-Policy, so
 * one appearing in the markup is a page that will silently render wrong rather
 * than a policy violation that shows up in a browser console during review.
 */
const FOREIGN_RESOURCE = /(?:src|href)\s*=\s*["']https?:\/\/(?!myaccount\.google\.com|developers\.google\.com)/i;

/** Things that must never be in a static page served to a browser. */
const FORBIDDEN_CONTENT = [
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/, description: "a model-provider API key" },
  { pattern: /\bya29\.[A-Za-z0-9._-]{20,}/, description: "a Google access token" },
  { pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, description: "a private key" },
  { pattern: /googletagmanager|google-analytics|gtag\(|plausible\.io|segment\.com/i, description: "analytics" },
  { pattern: /document\.cookie|localStorage|sessionStorage/, description: "browser storage of setup state" }
];

for (const file of walk(root)) {
  const name = relative(root, file).split(sep).join("/");
  const contents = readFileSync(file, "utf8");

  // Prose only. A character class in the page script (`[A-Za-z0-9_-]`) is not
  // an unfilled placeholder, and treating it as one would make this gate cry
  // wolf on the one file nobody should be tempted to silence it for.
  const placeholders = name.endsWith(".html") ? [...new Set(contents.match(PLACEHOLDER) ?? [])] : [];
  if (placeholders.length > 0) {
    failures.push(`${name} still contains release placeholders: ${placeholders.join(", ")}`);
  }
  if (name.endsWith(".html") && FOREIGN_RESOURCE.test(contents)) {
    failures.push(`${name} loads a third-party resource, which the site's CSP blocks.`);
  }
  for (const { pattern, description } of FORBIDDEN_CONTENT) {
    if (pattern.test(contents)) failures.push(`${name} contains ${description}.`);
  }
}

// The connect page hands the user's choice to a loopback listener. Accepting a
// callback URL from anywhere — the fragment, a query parameter, an opener —
// would turn a sign-in page into an open redirect, so the destination has to
// be built from a fixed scheme, host, and path.
const connectScript = readFileSync(join(root, "connect.js"), "utf8");
if (!/"http:"\s*\+|"http:\/\/"\s*\+/.test(connectScript) || !connectScript.includes("127.0.0.1")) {
  failures.push("connect.js must build its loopback destination from a fixed scheme and host.");
}
if (/[?&]redirect|returnUrl|callback=/i.test(connectScript)) {
  failures.push("connect.js appears to accept a callback or redirect URL, which it must never do.");
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

if (failures.length > 0) {
  console.error("\nHosting verification failed:");
  for (const failure of failures) console.error(`  !!  ${failure}`);
  process.exit(1);
}
console.log(`Hosting verified: ${REQUIRED_PAGES.length} pages, no placeholders, no third-party assets.`);
