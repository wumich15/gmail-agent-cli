import { describe, expect, it } from "vitest";
import {
  buildNormalizedMessage,
  headerMapFromList,
  htmlToBoundedPlainText,
  parseEmailAddress,
  parseEmailAddressList
} from "../../src/gmail/normalize.js";

describe("parseEmailAddress", () => {
  it("parses display name plus angle-bracket address", () => {
    expect(parseEmailAddress('"Alice Example" <alice@example.com>')).toEqual({
      raw: '"Alice Example" <alice@example.com>',
      address: "alice@example.com",
      displayName: "Alice Example"
    });
  });

  it("parses a bare address", () => {
    expect(parseEmailAddress("bob@example.com")).toEqual({
      raw: "bob@example.com",
      address: "bob@example.com",
      displayName: null
    });
  });

  it("returns null for null input", () => {
    expect(parseEmailAddress(null)).toBeNull();
  });
});

describe("parseEmailAddressList", () => {
  it("splits on commas outside angle brackets and quotes", () => {
    const result = parseEmailAddressList('"Doe, Jane" <jane@example.com>, bob@example.com');
    expect(result).toHaveLength(2);
    expect(result[0]!.address).toBe("jane@example.com");
    expect(result[1]!.address).toBe("bob@example.com");
  });
});

describe("htmlToBoundedPlainText", () => {
  it("strips script/style and tags", () => {
    const { text } = htmlToBoundedPlainText(
      "<html><style>.a{color:red}</style><script>evil()</script><body><p>Hello <b>world</b></p></body></html>"
    );
    expect(text).not.toContain("evil()");
    expect(text).not.toContain("color:red");
    expect(text).toContain("Hello world");
  });

  it("redacts URLs with secret-looking query values", () => {
    const { text } = htmlToBoundedPlainText(
      '<a href="https://example.com/unsub?token=abc123secret">unsubscribe</a>'
    );
    expect(text).not.toContain("abc123secret");
  });

  it("truncates and reports truncation past the char cap", () => {
    const { text, truncated } = htmlToBoundedPlainText("x".repeat(10), 5);
    expect(text).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it("strips quoted reply history", () => {
    const { text } = htmlToBoundedPlainText("Hi there\n\nOn Mon, Jan 1 wrote:\n> old content");
    expect(text).not.toContain("old content");
    expect(text).toContain("Hi there");
  });
});

describe("headerMapFromList", () => {
  it("is case-insensitive on header names", () => {
    const map = headerMapFromList([{ name: "subject", value: "Hello" }]);
    expect(map.subject).toBe("Hello");
  });
});

describe("buildNormalizedMessage", () => {
  it("produces a stable content hash for identical inputs", () => {
    const base = {
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      historyId: "1",
      internalDate: "1000",
      labelIds: ["INBOX"],
      snippet: "snip",
      headers: headerMapFromList([
        { name: "From", value: "alice@example.com" },
        { name: "Subject", value: "Hi" }
      ]),
      htmlBody: null,
      plainBody: "hello world",
      userEmail: "me@example.com",
      threadHasUserSentMessage: false
    };
    const a = buildNormalizedMessage(base);
    const b = buildNormalizedMessage({ ...base });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("marks isFromUser when the sender matches the account email", () => {
    const msg = buildNormalizedMessage({
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      historyId: "1",
      internalDate: "1000",
      labelIds: [],
      snippet: "",
      headers: headerMapFromList([{ name: "From", value: "Me@Example.com" }]),
      htmlBody: null,
      plainBody: null,
      userEmail: "me@example.com",
      threadHasUserSentMessage: false
    });
    expect(msg.isFromUser).toBe(true);
  });
});
