import { describe, expect, it, vi } from "vitest";
import { draftNewEmail, draftReply, summarizeWritingStyle } from "../../src/ai/draft-reply.js";
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

  it("includes the persisted style profile in input for style matching, never in instructions", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          responses: {
            create: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
              capturedParams = params;
              return { output_text: "Talk soon!" };
            })
          }
        }) as unknown as OpenAI
    );
    await draftReply(message(), { apiKey: "sk-test", model: "gpt-5.4-mini" }, {
      styleProfile: "Casual and brief, signs off with 'Talk soon!'"
    });
    const input = capturedParams?.["input"] as { content: string }[];
    expect(input[0]!.content).toContain("Casual and brief, signs off with 'Talk soon!'");
    expect(capturedParams?.["instructions"]).not.toContain("Casual and brief");
  });

  it("drafts a new email body with user-controlled addressing context and store:false", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          responses: {
            create: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
              capturedParams = params;
              return { output_text: "  Could we meet Tuesday?  " };
            })
          }
        }) as unknown as OpenAI
    );
    const result = await draftNewEmail(
      { to: "alice@example.com", subject: "Meeting", purpose: "Ask for a Tuesday meeting" },
      { apiKey: "sk-test", model: "gpt-5.4-mini" }
    );
    expect(result).toBe("Could we meet Tuesday?");
    expect(capturedParams?.["store"]).toBe(false);
    const input = capturedParams?.["input"] as { content: string }[];
    expect(input[0]!.content).toContain("Ask for a Tuesday meeting");
  });
});

describe("summarizeWritingStyle", () => {
  it("returns null without calling the API when there are no examples — nothing to persist yet", async () => {
    const create = vi.fn();
    vi.mocked(OpenAI).mockImplementation(() => ({ responses: { create } }) as unknown as OpenAI);
    const result = await summarizeWritingStyle([], { apiKey: "sk-test", model: "gpt-5.4-mini" });
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the trimmed, bounded style description on success, isolated in input never instructions", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          responses: {
            create: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
              capturedParams = params;
              return { output_text: "  Casual, short sentences, signs off with 'Thanks, Mike'.  " };
            })
          }
        }) as unknown as OpenAI
    );
    const result = await summarizeWritingStyle(
      [{ subject: "Checking in", body: "Hey! Quick note. Talk soon!" }],
      { apiKey: "sk-test", model: "gpt-5.4-mini" }
    );
    expect(result).toBe("Casual, short sentences, signs off with 'Thanks, Mike'.");
    expect(capturedParams?.["store"]).toBe(false);
    const input = capturedParams?.["input"] as { content: string }[];
    expect(input[0]!.content).toContain("Hey! Quick note. Talk soon!");
    expect(capturedParams?.["instructions"]).not.toContain("Hey! Quick note. Talk soon!");
  });

  it("returns null (never throws) when the API call fails", async () => {
    vi.mocked(OpenAI).mockImplementation(
      () => ({ responses: { create: vi.fn().mockRejectedValue(new Error("boom")) } }) as unknown as OpenAI
    );
    const result = await summarizeWritingStyle(
      [{ subject: "Hi", body: "Hello" }],
      { apiKey: "sk-test", model: "gpt-5.4-mini" }
    );
    expect(result).toBeNull();
  });
});
