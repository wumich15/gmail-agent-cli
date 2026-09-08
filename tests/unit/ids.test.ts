import { runScenarios } from "../helpers/scenarios.js";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonStringify,
  deterministicActionKey,
  deterministicCalendarEventId,
  payloadHash,
  toBase32Hex
} from "../../src/core/ids.js";

describe("deterministicCalendarEventId", () => {
  it("preserves all 3 scenarios", async () => {
    await runScenarios([
      { name: "is stable for identical inputs", run: () => {
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
  } },
      { name: "differs for different messages", run: () => {
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
  } },
      { name: "only uses characters Google Calendar accepts for event IDs", run: () => {
    const id = deterministicCalendarEventId({
      accountHash: "acct1",
      gmailMessageId: "msg1",
      candidateIndex: 0
    });
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
  } }
    ]);
  });
});

describe("deterministicActionKey", () => {
  it("preserves all 2 scenarios", async () => {
    await runScenarios([
      { name: "is stable across calls with the same logical action", run: () => {
    const args = { accountHash: "a", type: "trash", target: "msg1", payloadHash: "h" };
    expect(deterministicActionKey(args)).toBe(deterministicActionKey({ ...args }));
  } },
      { name: "differs when the target differs", run: () => {
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
  } }
    ]);
  });
});

describe("canonicalJsonStringify / payloadHash", () => {
  it("preserves all 3 scenarios", async () => {
    await runScenarios([
      { name: "produces the same hash regardless of object key order", run: () => {
    const a = { reasonCode: "x", event: { title: "T", confidence: 0.9 } };
    const b = { event: { confidence: 0.9, title: "T" }, reasonCode: "x" };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(payloadHash(a)).toBe(payloadHash(b));
  } },
      { name: "preserves array order (arrays are ordered data, not sorted)", run: () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe("[3,1,2]");
  } },
      { name: "still distinguishes genuinely different payloads", run: () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  } }
    ]);
  });
});

describe("toBase32Hex", () => {
  it("encodes using only the RFC 4648 base32hex alphabet", () => {
    const encoded = toBase32Hex(Buffer.from([0, 1, 2, 3, 255, 254]));
    expect(encoded).toMatch(/^[0-9a-v]+$/);
  });
});
