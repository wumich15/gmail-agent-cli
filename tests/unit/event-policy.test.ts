import { describe, expect, it } from "vitest";
import { sourceEvidencePresent, validateEventCandidate } from "../../src/calendar/event-policy.js";
import type { EventCandidate } from "../../src/core/models.js";

const NOW = new Date("2099-01-01T00:00:00Z");

function candidate(overrides: Partial<EventCandidate> = {}): EventCandidate {
  return {
    intent: "create",
    confidence: 0.99,
    title: "Dentist",
    start: "2099-06-01T10:00:00Z",
    end: "2099-06-01T11:00:00Z",
    allDay: false,
    timeZone: "UTC",
    location: null,
    sourceEvidence: "see you at 10am",
    ...overrides
  };
}

describe("validateEventCandidate", () => {
  it("accepts a valid future timed event", () => {
    const result = validateEventCandidate(candidate(), NOW, "UTC");
    expect(result.ok).toBe(true);
  });

  it("rejects a past event", () => {
    const result = validateEventCandidate(
      candidate({ start: "2020-01-01T10:00:00Z", end: "2020-01-01T11:00:00Z" }),
      NOW,
      "UTC"
    );
    expect(result).toEqual({ ok: false, reason: "past_event" });
  });

  it("rejects end before start", () => {
    const result = validateEventCandidate(
      candidate({ start: "2099-06-01T11:00:00Z", end: "2099-06-01T10:00:00Z" }),
      NOW,
      "UTC"
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an implausibly long timed event", () => {
    const result = validateEventCandidate(
      candidate({ start: "2099-06-01T10:00:00Z", end: "2099-06-05T10:00:00Z" }),
      NOW,
      "UTC"
    );
    expect(result).toEqual({ ok: false, reason: "implausible_duration" });
  });

  it("rejects a non-create intent", () => {
    const result = validateEventCandidate(candidate({ intent: "none" }), NOW, "UTC");
    expect(result.ok).toBe(false);
  });

  it("rejects a missing title", () => {
    const result = validateEventCandidate(candidate({ title: "" }), NOW, "UTC");
    expect(result).toEqual({ ok: false, reason: "missing_title" });
  });

  it("accepts an all-day event defaulting to a one-day span", () => {
    const result = validateEventCandidate(
      candidate({ allDay: true, start: "2099-06-01", end: null }),
      NOW,
      "UTC"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.allDay).toBe(true);
    }
  });
});

describe("sourceEvidencePresent", () => {
  it("is true when the evidence appears in the normalized body", () => {
    expect(sourceEvidencePresent("see you at 10am", "hi there, see you at 10am tomorrow")).toBe(true);
  });

  it("is false when the evidence is absent (possible hallucination)", () => {
    expect(sourceEvidencePresent("see you at 10am", "totally unrelated content")).toBe(false);
  });

  it("is false for null/empty evidence", () => {
    expect(sourceEvidencePresent(null, "anything")).toBe(false);
    expect(sourceEvidencePresent("  ", "anything")).toBe(false);
  });
});
