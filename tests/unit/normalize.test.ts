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

  it("does not fall through to the bare-address branch when the display name contains a newline", () => {
    // Regression: "." in the angle-bracket regex never matches a
    // newline, so a value with an embedded literal newline before the
    // address used to skip the angle-bracket branch entirely and treat
    // the whole raw (bracket-and-all) string as a bare address.
    const result = parseEmailAddress('"Alice\nExample" <alice@example.com>');
    expect(result?.address).toBe("alice@example.com");
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

  it("strips an unclosed <script> tag through the rest of the content instead of leaving it raw", () => {
    const { text } = htmlToBoundedPlainText("<p>Hello</p><script>doEvilThing(); no closing tag here");
    expect(text).not.toContain("doEvilThing");
    expect(text).toContain("Hello");
  });

  it("strips an unclosed <style> tag through the rest of the content instead of leaving it raw", () => {
    const { text } = htmlToBoundedPlainText("<p>Hello</p><style>.a{color:red} no closing tag here");
    expect(text).not.toContain("color:red");
    expect(text).toContain("Hello");
  });
});

describe("headerMapFromList", () => {
  it("is case-insensitive on header names", () => {
    const map = headerMapFromList([{ name: "subject", value: "Hello" }]);
    expect(map.subject).toBe("Hello");
  });

  it("keeps the FIRST occurrence of a duplicated header, not the last", () => {
    // A message can carry multiple copies of a header (most notably
    // Authentication-Results, added by each hop) — Gmail preserves
    // physical order, which places the receiving server's own header
    // first. Security-relevant matching should use a defined,
    // deliberate choice, not "whichever happened to be listed last."
    const map = headerMapFromList([
      { name: "Authentication-Results", value: "dkim=pass header.i=@trusted.example" },
      { name: "Authentication-Results", value: "dkim=fail header.i=@attacker.example" }
    ]);
    expect(map.authenticationResults).toBe("dkim=pass header.i=@trusted.example");
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

  it("keeps the same content hash when only labelIds differ (a star/archive/read-state change is not a content change)", () => {
    const base = {
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      historyId: "1",
      internalDate: "1000",
      labelIds: ["INBOX", "UNREAD"],
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
    const unread = buildNormalizedMessage(base);
    const read = buildNormalizedMessage({ ...base, labelIds: ["INBOX"] });
    expect(unread.contentHash).toBe(read.contentHash);
  });

  it("changes the content hash when an actual classifier input changes", () => {
    const base = {
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      historyId: "1",
      internalDate: "1000",
      labelIds: ["INBOX"],
      snippet: "first preview",
      headers: headerMapFromList([
        { name: "From", value: "alice@example.com" },
        { name: "Subject", value: "Hi" }
      ]),
      htmlBody: null,
      plainBody: null,
      userEmail: "me@example.com",
      threadHasUserSentMessage: false
    };
    const original = buildNormalizedMessage(base);
    const changedSnippet = buildNormalizedMessage({ ...base, snippet: "different preview" });
    const changedBulkSignal = buildNormalizedMessage({
      ...base,
      headers: headerMapFromList([
        { name: "From", value: "alice@example.com" },
        { name: "Subject", value: "Hi" },
        { name: "Precedence", value: "bulk" }
      ])
    });

    expect(changedSnippet.contentHash).not.toBe(original.contentHash);
    expect(changedBulkSignal.contentHash).not.toBe(original.contentHash);
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
