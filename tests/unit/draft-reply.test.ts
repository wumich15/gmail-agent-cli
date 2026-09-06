import { describe, expect, it, vi } from "vitest";
import { draftReply } from "../../src/ai/draft-reply.js";
import { buildNormalizedMessage, headerMapFromList } from "../../src/gmail/normalize.js";

function message(overrides: Partial<Parameters<typeof buildNormalizedMessage>[0]> = {}) {
  return buildNormalizedMessage({
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    historyId: "1",
    internalDate: "1000",
    labelIds: [],
    snippet: "Quick question about tomorrow.",
    headers: headerMapFromList([{ name: "From", value: "Alice <alice@example.com>" }, { name: "Subject", value: "Tomorrow" }]),
    htmlBody: null,
    plainBody: null,
    userEmail: "me@example.com",
    threadHasUserSentMessage: false,
    ...overrides
  });
}

vi.mock("openai", () => {
  return {
    default: vi.fn()
  };
});

import OpenAI from "openai";

describe("draftReply", () => {
  it("returns the trimmed output_text on success", async () => {
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          responses: { create: vi.fn().mockResolvedValue({ output_text: "  Sounds good, see you then.  " }) }
        }) as unknown as OpenAI
    );
    const result = await draftReply(message(), { apiKey: "sk-test", model: "gpt-5.4-mini" });
    expect(result).toBe("Sounds good, see you then.");
  });

  it("passes store:false and isolates the message content only in the input, never instructions", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          responses: {
            create: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
              capturedParams = params;
              return { output_text: "ok" };
            })
          }
        }) as unknown as OpenAI
    );
    await draftReply(message(), { apiKey: "sk-test", model: "gpt-5.4-mini" });
    expect(capturedParams?.["store"]).toBe(false);
    const input = capturedParams?.["input"] as { role: string; content: string }[];
    expect(input[0]!.content).toContain("Quick question about tomorrow.");
    expect(capturedParams?.["instructions"]).not.toContain("Quick question about tomorrow.");
  });

  it("returns null (never throws) when the API call fails", async () => {
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          responses: { create: vi.fn().mockRejectedValue(new Error("boom")) }
        }) as unknown as OpenAI
    );
    const result = await draftReply(message(), { apiKey: "sk-test", model: "gpt-5.4-mini" });
    expect(result).toBeNull();
  });

  it("returns null when the model produces empty output", async () => {
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          responses: { create: vi.fn().mockResolvedValue({ output_text: "   " }) }
        }) as unknown as OpenAI
    );
    const result = await draftReply(message(), { apiKey: "sk-test", model: "gpt-5.4-mini" });
    expect(result).toBeNull();
  });
});
