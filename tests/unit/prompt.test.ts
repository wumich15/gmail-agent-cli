import { describe, expect, it } from "vitest";
import {
  buildClassificationInput,
  buildDeterministicSummary,
  DEVELOPER_INSTRUCTIONS,
  FEW_SHOT_EXAMPLES
} from "../../src/ai/prompt.js";
import { EmailFlagsSchema } from "../../src/ai/schema.js";
import { buildNormalizedMessage, headerMapFromList } from "../../src/gmail/normalize.js";

function message(overrides: Partial<Parameters<typeof buildNormalizedMessage>[0]> = {}) {
  return buildNormalizedMessage({
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    historyId: "1",
    internalDate: "1000",
    labelIds: [],
    snippet: "This is the short preview snippet.",
    headers: headerMapFromList([
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "Subject", value: "Hello" }
    ]),
    htmlBody: null,
    plainBody: null,
    userEmail: "me@example.com",
    threadHasUserSentMessage: false,
    ...overrides
  });
}

describe("DEVELOPER_INSTRUCTIONS", () => {
  it("tells the model to ignore instructions embedded in the email content", () => {
    expect(DEVELOPER_INSTRUCTIONS).toMatch(/ignore/i);
    expect(DEVELOPER_INSTRUCTIONS).toMatch(/untrusted|not instructions/i);
  });

  it("states the model has no tools and cannot take action", () => {
    expect(DEVELOPER_INSTRUCTIONS).toMatch(/no tools/i);
  });
});

describe("buildClassificationInput", () => {
  it("includes From, Subject, and the message content", () => {
    const input = buildClassificationInput(message());
    expect(input).toContain("alice@example.com");
    expect(input).toContain("Hello");
    expect(input).toContain("This is the short preview snippet.");
  });

  it("labels snippet-only content as a preview, not the full body", () => {
    const input = buildClassificationInput(message());
    expect(input).toMatch(/short preview snippet/);
  });

  it("labels full body content as such when present", () => {
    const input = buildClassificationInput(
      message({ plainBody: "This is the full message body content." })
    );
    expect(input).toContain("This is the full message body content.");
    expect(input).not.toMatch(/short preview snippet/);
  });

  it("never includes raw List-Unsubscribe or Authentication-Results values, only a derived boolean", () => {
    const input = buildClassificationInput(
      message({
        headers: headerMapFromList([
          { name: "From", value: "list@example.com" },
          { name: "List-ID", value: "<promo.example.com>" },
          { name: "List-Unsubscribe", value: "<https://example.com/unsub?token=SECRET123>" },
          { name: "Authentication-Results", value: "dkim=pass header.i=@example.com" }
        ])
      })
    );
    expect(input).not.toContain("SECRET123");
    expect(input).not.toContain("dkim=pass");
    expect(input).toMatch(/Bulk\/list mail signal present: yes/);
  });

  it("truncates very long content and notes the truncation", () => {
    const input = buildClassificationInput(message({ plainBody: "x".repeat(10_000) }));
    expect(input).toContain("[content truncated]");
  });

  it("does not leave a double space in the From line when there is no display name", () => {
    const input = buildClassificationInput(
      message({ headers: headerMapFromList([{ name: "From", value: "bare@example.com" }]) })
    );
    expect(input).toContain("From: <bare@example.com>");
    expect(input).not.toMatch(/From: {2,}</);
  });
});

describe("buildDeterministicSummary", () => {
  it("combines the subject and the first non-blank line of content, with no AI call", () => {
    const summary = buildDeterministicSummary(
      message({ plainBody: "\n\nHi there, quick reminder about tomorrow.\nSecond line." })
    );
    expect(summary).toBe("Hello — Hi there, quick reminder about tomorrow.");
  });

  it("falls back to just the subject when there is no content", () => {
    const summary = buildDeterministicSummary(message({ snippet: "" }));
    expect(summary).toBe("Hello");
  });
});

describe("FEW_SHOT_EXAMPLES", () => {
  it("has at least a couple of examples, each with schema-valid output", () => {
    expect(FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(2);
    for (const example of FEW_SHOT_EXAMPLES) {
      expect(() => EmailFlagsSchema.parse(example.output)).not.toThrow();
    }
  });

  it("covers the spam and suspicious cases distinctly", () => {
    const kinds = FEW_SHOT_EXAMPLES.map((e) => ({ spam: e.output.spam, suspicious: e.output.suspicious }));
    expect(kinds).toContainEqual({ spam: true, suspicious: false });
    expect(kinds).toContainEqual({ spam: false, suspicious: true });
  });
});
