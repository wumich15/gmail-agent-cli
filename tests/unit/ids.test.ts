import { describe, expect, it } from "vitest";
import {
  canonicalJsonStringify,
  deterministicActionKey,
  deterministicCalendarEventId,
  payloadHash,
  toBase32Hex
} from "../../src/core/ids.js";

describe("deterministicCalendarEventId", () => {
  it("is stable for identical inputs", () => {
    const a = deterministicCalendarEventId({
      accountHash: "acct1",
      gmailMessageId: "msg1",
      candidateIndex: 0
    });
    const b = deterministicCalendarEventId({
      accountHash: "acct1",
      gmailMessageId: "msg1",
      candidateIndex: 0
    });
    expect(a).toBe(b);
  });

  it("differs for different messages", () => {
    const a = deterministicCalendarEventId({
      accountHash: "acct1",
      gmailMessageId: "msg1",
      candidateIndex: 0
    });
    const b = deterministicCalendarEventId({
      accountHash: "acct1",
      gmailMessageId: "msg2",
      candidateIndex: 0
    });
    expect(a).not.toBe(b);
  });

  it("only uses characters Google Calendar accepts for event IDs", () => {
    const id = deterministicCalendarEventId({
      accountHash: "acct1",
      gmailMessageId: "msg1",
      candidateIndex: 0
    });
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});

describe("deterministicActionKey", () => {
  it("is stable across calls with the same logical action", () => {
    const args = { accountHash: "a", type: "trash", target: "msg1", payloadHash: "h" };
    expect(deterministicActionKey(args)).toBe(deterministicActionKey({ ...args }));
  });

  it("differs when the target differs", () => {
    const key1 = deterministicActionKey({
      accountHash: "a",
      type: "trash",
      target: "msg1",
      payloadHash: "h"
    });
    const key2 = deterministicActionKey({
      accountHash: "a",
      type: "trash",
      target: "msg2",
      payloadHash: "h"
    });
    expect(key1).not.toBe(key2);
  });
});

describe("canonicalJsonStringify / payloadHash", () => {
  it("produces the same hash regardless of object key order", () => {
    const a = { reasonCode: "x", event: { title: "T", confidence: 0.9 } };
    const b = { event: { confidence: 0.9, title: "T" }, reasonCode: "x" };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it("preserves array order (arrays are ordered data, not sorted)", () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("still distinguishes genuinely different payloads", () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });
});

describe("toBase32Hex", () => {
  it("encodes using only the RFC 4648 base32hex alphabet", () => {
    const encoded = toBase32Hex(Buffer.from([0, 1, 2, 3, 255, 254]));
    expect(encoded).toMatch(/^[0-9a-v]+$/);
  });
});
