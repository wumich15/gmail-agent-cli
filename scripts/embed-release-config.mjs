import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve("dist/auth/publisher-client.js");
const required = {
  "__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID__": process.env["GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID"],
  "__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET__": process.env["GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET"],
  "__GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL__": process.env["GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL"]
};

for (const [marker, value] of Object.entries(required)) {
  if (!value) throw new Error(`Missing release setting for ${marker}`);
}

if (!required["__GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID__"].endsWith(".apps.googleusercontent.com")) {
  throw new Error("GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID is not a Google OAuth client ID.");
}

const gateway = new URL(required["__GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL__"]);
if (gateway.protocol !== "https:") {
  throw new Error("GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL must use HTTPS for a release.");
}

let output = readFileSync(target, "utf8");
for (const [marker, value] of Object.entries(required)) {
  if (!output.includes(marker)) throw new Error(`Release marker not found in ${target}: ${marker}`);
  output = output.replaceAll(JSON.stringify(marker), JSON.stringify(value));
}
writeFileSync(target, output, { mode: 0o644 });

console.log("Embedded publisher OAuth and managed AI settings into the release build.");
