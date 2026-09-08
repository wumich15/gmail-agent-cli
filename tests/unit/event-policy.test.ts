import { runScenarios } from "../helpers/scenarios.js";
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
  it("preserves all 11 scenarios", async () => {
    await runScenarios([
      { name: "accepts a valid future timed event", run: () => {
    const result = validateEventCandidate(candidate(), NOW, "UTC");
    expect(result.ok).toBe(true);
  } },
      { name: "rejects a past event", run: () => {
    const result = validateEventCandidate(
      candidate({ start: "2020-01-01T10:00:00Z", end: "2020-01-01T11:00:00Z" }),
      NOW,
      "UTC"
    );
    expect(result).toEqual({ ok: false, reason: "past_event" });
  } },
      { name: "rejects end before start", run: () => {
    const result = validateEventCandidate(
      candidate({ start: "2099-06-01T11:00:00Z", end: "2099-06-01T10:00:00Z" }),
      NOW,
      "UTC"
    );
    expect(result.ok).toBe(false);
  } },
      { name: "rejects an implausibly long timed event", run: () => {
    const result = validateEventCandidate(
      candidate({ start: "2099-06-01T10:00:00Z", end: "2099-06-05T10:00:00Z" }),
      NOW,
      "UTC"
    );
    expect(result).toEqual({ ok: false, reason: "implausible_duration" });
  } },
      { name: "rejects a non-create intent", run: () => {
    const result = validateEventCandidate(candidate({ intent: "none" }), NOW, "UTC");
    expect(result.ok).toBe(false);
  } },
      { name: "rejects a missing title", run: () => {
    const result = validateEventCandidate(candidate({ title: "" }), NOW, "UTC");
    expect(result).toEqual({ ok: false, reason: "missing_title" });
  } },
      { name: "accepts an all-day event defaulting to a one-day span", run: () => {
    const result = validateEventCandidate(
      candidate({ allDay: true, start: "2099-06-01", end: null }),
      NOW,
      "UTC"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.allDay).toBe(true);
      expect(result.event.startIso).toBe("2099-06-01");
      // Exclusive end date, one day after the (only) day of the event.
      expect(result.event.endIso).toBe("2099-06-02");
    }
  } },
      { name: "stores a multi-day all-day event with the correct exclusive end date, not one day short", run: () => {
    // Regression: an explicit end date used to be stored verbatim instead
    // of bumped to Google Calendar's required exclusive-end convention,
    // silently dropping the event's last day.
    const result = validateEventCandidate(
      candidate({ allDay: true, start: "2099-06-12", end: "2099-06-14" }),
      NOW,
      "UTC"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.startIso).toBe("2099-06-12");
      expect(result.event.endIso).toBe("2099-06-15");
    }
  } },
      { name: "accepts a same-day all-day event (start === end) instead of rejecting it as non-positive duration", run: () => {
    // Regression: start and end both parsed to midnight of the same day,
    // making `end <= start` true and rejecting a perfectly ordinary
    // single-day event expressed with an explicit (equal) end date.
    const result = validateEventCandidate(
      candidate({ allDay: true, start: "2099-06-01", end: "2099-06-01" }),
      NOW,
      "UTC"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.startIso).toBe("2099-06-01");
      expect(result.event.endIso).toBe("2099-06-02");
    }
  } },
      { name: "accepts an all-day event dated today instead of rejecting it as a past event", run: () => {
    // Regression: an all-day candidate parses to midnight of its date,
    // which is always earlier than the current instant "now" later that
    // same day, so every same-day deadline was unconditionally rejected.
    const today = "2099-06-15";
    const nowLaterThatDay = new Date("2099-06-15T18:30:00Z");
    const result = validateEventCandidate(candidate({ allDay: true, start: today, end: null }), nowLaterThatDay, "UTC");
    expect(result.ok).toBe(true);
  } },
      { name: "still rejects an all-day event dated yesterday as a past event", run: () => {
    const result = validateEventCandidate(
      candidate({ allDay: true, start: "2099-06-14", end: null }),
      new Date("2099-06-15T00:00:01Z"),
      "UTC"
    );
    expect(result).toEqual({ ok: false, reason: "past_event" });
  } }
    ]);
  });
});

describe("sourceEvidencePresent", () => {
  it("preserves all 3 scenarios", async () => {
    await runScenarios([
      { name: "is true when the evidence appears in the normalized body", run: () => {
    expect(sourceEvidencePresent("see you at 10am", "hi there, see you at 10am tomorrow")).toBe(true);
  } },
      { name: "is false when the evidence is absent (possible hallucination)", run: () => {
    expect(sourceEvidencePresent("see you at 10am", "totally unrelated content")).toBe(false);
  } },
      { name: "is false for null/empty evidence", run: () => {
    expect(sourceEvidencePresent(null, "anything")).toBe(false);
    expect(sourceEvidencePresent("  ", "anything")).toBe(false);
  } }
    ]);
  });
});
