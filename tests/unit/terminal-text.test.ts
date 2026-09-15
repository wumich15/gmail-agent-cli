import { describe, expect, it } from "vitest";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../../src/core/terminal-text.js";
import { htmlToBoundedPlainText, buildNormalizedMessage, headerMapFromList } from "../../src/gmail/normalize.js";
import { buildReplyTarget } from "../../src/gmail/reply.js";

const ESC = String.fromCharCode(27);
const CSI_C1 = String.fromCharCode(0x9b);
const RTL_OVERRIDE = String.fromCharCode(0x202e);

describe("sanitizeTerminalText", () => {
  it("removes escape sequences a sender could use to repaint the terminal", () => {
    expect(sanitizeTerminalText(`before ${ESC}[2J${ESC}[H after`)).toBe("before [2J[H after");
  });

  it("removes a forged OSC 8 hyperlink, which the read view's own link labels rely on", () => {
    const forged = `${ESC}]8;;https://evil.example${ESC}\\Your bank${ESC}]8;;${ESC}\\`;
    expect(sanitizeTerminalText(forged)).not.toContain(ESC);
  });

  it("keeps real line breaks and tabs but drops carriage returns and C1 controls", () => {
    expect(sanitizeTerminalText(`a\r\nb\tc${CSI_C1}d`)).toBe("a\nb\tcd");
  });

  it("removes bidi overrides used to make one address read as another", () => {
    expect(sanitizeTerminalLine(`moc.live${RTL_OVERRIDE}@support`)).toBe("moc.live@support");
  });

  it("collapses a multi-line value to one line for single-line fields", () => {
    expect(sanitizeTerminalLine("Subject\nspliced")).toBe("Subject spliced");
  });
});

describe("untrusted mail text reaching the terminal", () => {
  // Regression: nothing sanitized terminal control characters, so an escape
  // byte in a body — directly in a text/plain part, or as "&#27;" in HTML,
  // which the entity decoder faithfully turns into a real escape — reached
  // the terminal verbatim.
  it("strips an escape smuggled through an HTML numeric entity", () => {
    const { text } = htmlToBoundedPlainText("<p>Hi &#27;]8;;https://evil.example&#27;\\Click&#27;]8;;&#27;\\</p>");
    expect(text).toContain(ESC); // normalization itself is unchanged
    expect(sanitizeTerminalText(text)).not.toContain(ESC);
  });

  it("keeps a control character out of a reply's subject header", () => {
    const message = buildNormalizedMessage({
      gmailMessageId: "m",
      gmailThreadId: "t",
      historyId: "1",
      internalDate: "1",
      labelIds: [],
      snippet: "",
      headers: headerMapFromList([
        { name: "From", value: "sender@example.com" },
        { name: "Subject", value: `Invoice ${ESC}[2J attached` },
        { name: "Message-ID", value: "<abc@example.com>" }
      ]),
      htmlBody: null,
      plainBody: "body",
      userEmail: "me@example.com",
      threadHasUserSentMessage: false
    });
    const target = buildReplyTarget(message)!;
    expect(target.subject).toBe("Re: Invoice [2J attached");
    expect(target.subject).not.toContain(ESC);
  });
});
