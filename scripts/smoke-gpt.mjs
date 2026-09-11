import { OpenAiClassifier } from "../dist/ai/openai-classifier.js";
import { draftReply } from "../dist/ai/draft-reply.js";
import { DEFAULT_COMPOSE_MODEL, DEFAULT_MODEL } from "../dist/config/schema.js";
import { buildNormalizedMessage, headerMapFromList } from "../dist/gmail/normalize.js";

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) throw new Error("OPENAI_API_KEY is required for the GPT smoke test.");

const message = buildNormalizedMessage({
  gmailMessageId: "synthetic-message",
  gmailThreadId: "synthetic-thread",
  historyId: "1",
  internalDate: String(Date.now()),
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Could we move our project check-in to Friday at 10 AM?",
  headers: headerMapFromList([
    { name: "From", value: "Teammate <teammate@example.com>" },
    { name: "To", value: "me@example.com" },
    { name: "Subject", value: "Project check-in" },
    { name: "Date", value: new Date().toUTCString() }
  ]),
  htmlBody: null,
  plainBody: "Could we move our project check-in to Friday at 10 AM?",
  userEmail: "me@example.com",
  threadHasUserSentMessage: false
});

const classifyModel = process.env["GMAIL_AGENT_MODEL"] ?? DEFAULT_MODEL;
const composeModel = process.env["GMAIL_AGENT_COMPOSE_MODEL"] ?? DEFAULT_COMPOSE_MODEL;
const classifier = new OpenAiClassifier({ apiKey, model: classifyModel });
const assessment = await classifier.assess(message, {
  classifierVersion: "smoke",
  promptVersion: "smoke",
  schemaVersion: "smoke",
  policyVersion: "smoke"
});
if (!assessment.ok) throw new Error(`GPT classification failed: ${assessment.unavailable.detail}`);

const draft = await draftReply(message, { provider: "openai", apiKey, model: composeModel }, {
  guidance: "Confirm that Friday at 10 AM works."
});
if (!draft) throw new Error("GPT drafting failed.");

console.log(
  `GPT smoke test passed: classification=${assessment.assessment.kind} (${classifyModel}), draft=${draft.length} chars (${composeModel}).`
);
