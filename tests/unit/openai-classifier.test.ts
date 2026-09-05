import { describe, expect, it } from "vitest";
import { AuthenticationError, RateLimitError, APIConnectionTimeoutError } from "openai";
import type OpenAI from "openai";
import { OpenAiClassifier } from "../../src/ai/openai-classifier.js";
import { buildNormalizedMessage, headerMapFromList } from "../../src/gmail/normalize.js";

function message() {
  return buildNormalizedMessage({
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    historyId: "1",
    internalDate: "1000",
    labelIds: [],
    snippet: "snippet text",
    headers: headerMapFromList([{ name: "From", value: "a@example.com" }, { name: "Subject", value: "Hi" }]),
    htmlBody: null,
    plainBody: null,
    userEmail: "me@example.com",
    threadHasUserSentMessage: false
  });
}

function fakeClient(parseImpl: () => Promise<unknown>): OpenAI {
  return { responses: { parse: parseImpl } } as unknown as OpenAI;
}

const CONTEXT = { classifierVersion: "x", promptVersion: "x", schemaVersion: "x", policyVersion: "x" };

function validAssessment() {
  return {
    kind: "promotion" as const,
    confidence: 0.95,
    importanceScore: 0.1,
    importanceConfidence: 0.1,
    summary: "A promotional email.",
    reasonCodes: ["marketing_content" as const],
    event: {
      intent: "none" as const,
      confidence: 0,
      title: null,
      start: null,
      end: null,
      allDay: false,
      timeZone: null,
      location: null,
      sourceEvidence: null
    }
  };
}

describe("OpenAiClassifier", () => {
  it("returns ok:true with the parsed assessment and its own version tags on success", async () => {
    const client = fakeClient(async () => ({ output_parsed: validAssessment(), output: [] }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.6-terra", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.kind).toBe("promotion");
      expect(result.assessment.classifierVersion).toBe("openai:gpt-5.6-terra");
    }
  });

  it("returns schema_failure when output_parsed is null with no refusal", async () => {
    const client = fakeClient(async () => ({ output_parsed: null, output: [] }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.6-terra", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable.reason).toBe("schema_failure");
    }
  });

  it("returns refused when the response contains a refusal content part", async () => {
    const client = fakeClient(async () => ({
      output_parsed: null,
      output: [{ content: [{ type: "refusal", refusal: "I can't help with that." }] }]
    }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.6-terra", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable.reason).toBe("refused");
      expect(result.unavailable.detail).toBe("I can't help with that.");
    }
  });

  it("maps a timeout error to reason: timeout", async () => {
    const client = fakeClient(async () => {
      throw new APIConnectionTimeoutError();
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.6-terra", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unavailable.reason).toBe("timeout");
  });

  it("maps an authentication error to reason: not_configured", async () => {
    const client = fakeClient(async () => {
      throw new AuthenticationError(401, { error: { message: "bad key" } }, "bad key", {});
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.6-terra", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unavailable.reason).toBe("not_configured");
  });

  it("maps a rate-limit error to reason: provider_unavailable", async () => {
    const client = fakeClient(async () => {
      throw new RateLimitError(429, { error: { message: "quota" } }, "quota", {});
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.6-terra", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unavailable.reason).toBe("provider_unavailable");
  });

  it("never throws out of assess(), even for an unexpected error shape", async () => {
    const client = fakeClient(async () => {
      throw new Error("something weird");
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.6-terra", client });
    await expect(classifier.assess(message(), CONTEXT)).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
  });
});
