import { describe, expect, it } from "vitest";
import { AuthenticationError, RateLimitError, APIConnectionTimeoutError } from "openai";
import type OpenAI from "openai";
import { OpenAiClassifier } from "../../src/ai/openai-classifier.js";
import { buildNormalizedMessage, headerMapFromList } from "../../src/gmail/normalize.js";
import type { EmailFlags } from "../../src/ai/schema.js";

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

function fakeClient(parseImpl: (params: unknown) => Promise<unknown>): OpenAI {
  return { responses: { parse: parseImpl } } as unknown as OpenAI;
}

const CONTEXT = { classifierVersion: "x", promptVersion: "x", schemaVersion: "x", policyVersion: "x" };

function flags(overrides: Partial<EmailFlags> = {}): EmailFlags {
  return {
    spam: false,
    suspicious: false,
    important: false,
    hasEvent: false,
    eventTitle: null,
    eventStart: null,
    eventEnd: null,
    eventAllDay: false,
    category: null,
    ...overrides
  };
}

describe("OpenAiClassifier", () => {
  it("never sends store:true, tools, or previous_response_id (stateless, isolated call)", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const client = fakeClient(async (params) => {
      capturedParams = params as Record<string, unknown>;
      return { output_parsed: flags(), output: [] };
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    await classifier.assess(message(), CONTEXT);

    expect(capturedParams?.["store"]).toBe(false);
    expect(capturedParams?.["tools"]).toBeUndefined();
    expect(capturedParams?.["previous_response_id"]).toBeUndefined();
  });

  it("sends the few-shot examples plus the real message as separate input turns", async () => {
    let capturedInput: unknown;
    const client = fakeClient(async (params) => {
      capturedInput = (params as { input: unknown }).input;
      return { output_parsed: flags(), output: [] };
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    await classifier.assess(message(), CONTEXT);

    expect(Array.isArray(capturedInput)).toBe(true);
    const turns = capturedInput as { role: string; content: string }[];
    // At least 2 examples * 2 turns each, plus the real message.
    expect(turns.length).toBeGreaterThanOrEqual(5);
    expect(turns[turns.length - 1]!.role).toBe("user");
    expect(turns[turns.length - 1]!.content).toContain("a@example.com");
  });

  it("maps spam:true to a promotion assessment that clears the trash confidence threshold", async () => {
    const client = fakeClient(async () => ({ output_parsed: flags({ spam: true }), output: [] }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.kind).toBe("promotion");
      expect(result.assessment.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("maps suspicious:true to a suspicious assessment regardless of other flags (safety override)", async () => {
    const client = fakeClient(async () => ({
      output_parsed: flags({ suspicious: true, important: true, hasEvent: true, eventTitle: "x", eventStart: "2099-01-01" }),
      output: []
    }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.kind).toBe("suspicious");
      // Extracted facts from a suspicious message are never trusted for
      // either field, symmetrically — not just kind/category.
      expect(result.assessment.event.intent).toBe("none");
      expect(result.assessment.category).toBeNull();
    }
  });

  it("maps important:true to importance scores that clear the star threshold", async () => {
    const client = fakeClient(async () => ({ output_parsed: flags({ important: true }), output: [] }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.importanceScore).toBeGreaterThanOrEqual(0.9);
      expect(result.assessment.importanceConfidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("maps hasEvent:false to a non-create event with sub-threshold confidence", async () => {
    const client = fakeClient(async () => ({ output_parsed: flags(), output: [] }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.event.intent).toBe("none");
      expect(result.assessment.event.confidence).toBeLessThan(0.9);
    }
  });

  it("maps hasEvent:true to a create-intent event carrying the model's fields through", async () => {
    const client = fakeClient(async () => ({
      output_parsed: flags({ hasEvent: true, eventTitle: "Dentist", eventStart: "2099-01-01T10:00:00", eventAllDay: false }),
      output: []
    }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.event).toMatchObject({
        intent: "create",
        title: "Dentist",
        start: "2099-01-01T10:00:00"
      });
      expect(result.assessment.event.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("uses a deterministic subject+first-line summary, not model output (schema has no summary field)", async () => {
    const client = fakeClient(async () => ({ output_parsed: flags(), output: [] }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.summary).toContain("Hi");
      expect(result.assessment.summary).toContain("snippet text");
    }
  });

  it("maps a category flag through to the assessment", async () => {
    const client = fakeClient(async () => ({ output_parsed: flags({ category: "Shopping" }), output: [] }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.category).toBe("Shopping");
    }
  });

  it("forces category to null for a suspicious message even if the model set one (safety override)", async () => {
    const client = fakeClient(async () => ({
      output_parsed: flags({ suspicious: true, category: "Finance" }),
      output: []
    }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.category).toBeNull();
    }
  });

  it("passes existingLabels from the classify context into the developer instructions", async () => {
    let capturedInstructions: unknown;
    const client = fakeClient(async (params) => {
      capturedInstructions = (params as { instructions: unknown }).instructions;
      return { output_parsed: flags(), output: [] };
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    await classifier.assess(message(), { ...CONTEXT, existingLabels: ["Shopping", "Travel"] });
    expect(capturedInstructions).toContain("Shopping");
    expect(capturedInstructions).toContain("Travel");
  });

  it("returns schema_failure when output_parsed is null with no refusal", async () => {
    const client = fakeClient(async () => ({ output_parsed: null, output: [] }));
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
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
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
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
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unavailable.reason).toBe("timeout");
  });

  it("maps an authentication error to reason: not_configured", async () => {
    const client = fakeClient(async () => {
      throw new AuthenticationError(401, { error: { message: "bad key" } }, "bad key", {});
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unavailable.reason).toBe("not_configured");
  });

  it("maps a rate-limit error to reason: provider_unavailable", async () => {
    const client = fakeClient(async () => {
      throw new RateLimitError(429, { error: { message: "quota" } }, "quota", {});
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unavailable.reason).toBe("provider_unavailable");
  });

  it("retries a transient rate-limit error and succeeds once the underlying call recovers", async () => {
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      if (calls < 3) {
        throw new RateLimitError(429, { error: { message: "quota" } }, "quota", {});
      }
      return { output_parsed: flags(), output: [] };
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    const result = await classifier.assess(message(), CONTEXT);
    expect(calls).toBe(3);
    expect(result.ok).toBe(true);
  });

  it("never throws out of assess(), even for an unexpected error shape", async () => {
    const client = fakeClient(async () => {
      throw new Error("something weird");
    });
    const classifier = new OpenAiClassifier({ model: "gpt-5.4-mini", client });
    await expect(classifier.assess(message(), CONTEXT)).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
  });
});
