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
  it("preserves all 12 scenarios", async () => {
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
      { name: "falls back to a default length when the stated end is before the start", run: () => {
    // The commitment is when it starts; an end the model got backwards is a
    // reason to use a sensible default length, not to throw away a date the
    // message really does state. The start is still evidence-checked.
    const result = validateEventCandidate(
      candidate({ start: "2099-06-01T11:00:00Z", end: "2099-06-01T10:00:00Z" }),
      NOW,
      "UTC"
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.event.startIso).toContain("2099-06-01T11:00");
    expect(result.ok && result.event.endIso).toContain("2099-06-01T12:00");
  } },
      { name: "shortens an implausibly long timed event instead of discarding it", run: () => {
    const result = validateEventCandidate(
      candidate({ start: "2099-06-01T10:00:00Z", end: "2099-06-05T10:00:00Z" }),
      NOW,
      "UTC"
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.event.endIso).toContain("2099-06-01T11:00");
  } },
      { name: "treats a date-only start as all-day however the model labelled it", run: () => {
    // "2099-06-01" as a timed event put a real appointment at midnight, and
    // for anything later the same day it was then rejected as past.
    const result = validateEventCandidate(
      candidate({ start: "2099-06-01", end: null, allDay: false }),
      NOW,
      "UTC"
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.event.allDay).toBe(true);
    expect(result.ok && result.event.startIso).toBe("2099-06-01");
    expect(result.ok && result.event.endIso).toBe("2099-06-02");
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

describe("sourceEvidencePresent", () => {
  const body = "Hi Sam,\n\nYour appointment is confirmed for\nThursday, September 18 at 2:00 PM.\n\nThanks";

  it("accepts a quote whose line break the model rendered as a space", () => {
    // The body wraps mid-sentence; the model quotes it as one line. An exact
    // substring match on the raw body called that a hallucination and threw
    // away a real appointment.
    expect(sourceEvidencePresent("confirmed for Thursday, September 18 at 2:00 PM", body)).toBe(true);
  });

  it("accepts evidence that appears only in the subject", () => {
    // Plenty of mail states the date in the subject and nowhere else.
    expect(sourceEvidencePresent("Thu Sep 18, 2pm", null, "Your appointment — Thu Sep 18, 2pm")).toBe(true);
  });

  it("still rejects a date the message never states", () => {
    expect(sourceEvidencePresent("Friday, September 19 at 4:00 PM", body, "Your appointment")).toBe(false);
    expect(sourceEvidencePresent(null, body)).toBe(false);
    expect(sourceEvidencePresent("   ", body)).toBe(false);
  });
});
