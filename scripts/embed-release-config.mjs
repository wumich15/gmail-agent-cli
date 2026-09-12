#!/usr/bin/env node
/**
 * Embeds the publisher's release configuration into a built package.
 *
 * Run after `pnpm build`, from the publisher's secret-managed build
 * environment. The source tree keeps markers instead of real values so a
 * developer's own Cloud project can never be published by accident, and so a
 * checkout that someone builds themselves is honest about having no publisher
 * behind it.
 *
 * Nothing secret is embedded. An installed-app OAuth client ID and secret are
 * explicitly not confidential for the native-app flow (which is why the CLI
 * also uses PKCE S256, a random state, and a loopback-only redirect), the
 * gateway URL is public by construction, and a Firebase Web API key is a
 * project identifier rather than a credential. A model-provider key is a
 * different matter entirely and must never appear here;
 * scripts/verify-package.mjs fails the release if one shows up in the tarball.
 *
 * Usage:
 *   GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID=... \
 *   GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET=... \
 *   GMAIL_AGENT_PUBLISHER_SETUP_PAGE_URL=https://setup.example.com \
 *   GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL=https://ai.example.com \
 *   GMAIL_AGENT_PUBLISHER_FIREBASE_API_KEY=... \
 *   node scripts/embed-release-config.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve("dist/auth/publisher-client.js");

const settings = {
  __GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID__: process.env["GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID"],
  __GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET__: process.env["GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET"],
  __GMAIL_AGENT_PUBLISHER_SETUP_PAGE_URL__: process.env["GMAIL_AGENT_PUBLISHER_SETUP_PAGE_URL"],
  __GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL__: process.env["GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL"],
  __GMAIL_AGENT_PUBLISHER_FIREBASE_API_KEY__: process.env["GMAIL_AGENT_PUBLISHER_FIREBASE_API_KEY"]
};

for (const [marker, value] of Object.entries(settings)) {
  if (!value) throw new Error(`Missing release setting for ${marker}.`);
}

if (!settings["__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID__"].endsWith(".apps.googleusercontent.com")) {
  throw new Error("GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID is not a Google OAuth client ID.");
}

for (const name of ["__GMAIL_AGENT_PUBLISHER_SETUP_PAGE_URL__", "__GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL__"]) {
  const url = new URL(settings[name]);
  // A release must never ship a loopback or plaintext endpoint: the CLI
  // permits http on 127.0.0.1 so the gateway can be run locally during
  // development, and that allowance must not escape into a published package.
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS in a release build.`);
  if (url.search || url.hash) throw new Error(`${name} must not carry a query string or fragment.`);
}

// A Secret-Manager-shaped value in any of these would mean a provider key was
// pasted into the wrong variable. Fail loudly rather than publish it.
for (const [marker, value] of Object.entries(settings)) {
  if (/^sk-/.test(value) || /^sk-or-/.test(value)) {
    throw new Error(`${marker} looks like a model-provider API key. A provider key is never embedded in the package.`);
  }
}

let output = readFileSync(target, "utf8");
for (const [marker, value] of Object.entries(settings)) {
  if (!output.includes(marker)) throw new Error(`Release marker not found in ${target}: ${marker}`);
  output = output.replaceAll(JSON.stringify(marker), JSON.stringify(value));
}
writeFileSync(target, output, { mode: 0o644 });

console.log("Embedded the publisher OAuth client, setup page, AI gateway, and Firebase project into the build.");
