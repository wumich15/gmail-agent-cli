import { DateTime } from "luxon";
import type { EventCandidate } from "../core/models.js";

const MAX_TIMED_DURATION_HOURS = 24;
const MAX_ALL_DAY_DURATION_DAYS = 14;

export interface ValidatedEvent {
  title: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  timeZone: string;
}

export type EventValidationResult =
  | { ok: true; event: ValidatedEvent }
  | { ok: false; reason: string };

/**
 * Validates an AI-extracted event candidate in real code (never trusting
 * the model's own date arithmetic): explicit future dates, a valid range,
 * a plausible duration, and a resolvable timezone. `sourceEvidence` must be
 * checked by the caller against the normalized message text before this
 * runs; this function only validates the date/time shape.
 */
export function validateEventCandidate(
  candidate: EventCandidate,
  now: Date,
  userTimeZone: string
): EventValidationResult {
  if (candidate.intent !== "create") {
    return { ok: false, reason: "not_a_create_intent" };
  }
  if (!candidate.title || candidate.title.trim().length === 0) {
    return { ok: false, reason: "missing_title" };
  }
  if (!candidate.start) {
    return { ok: false, reason: "missing_start" };
  }

  const zone = candidate.timeZone ?? userTimeZone;
  if (!DateTime.local().setZone(zone).isValid) {
    return { ok: false, reason: "invalid_timezone" };
  }

  const start = candidate.allDay
    ? DateTime.fromISO(candidate.start, { zone })
    : DateTime.fromISO(candidate.start, { zone, setZone: true });
  if (!start.isValid) {
    return { ok: false, reason: "invalid_start" };
  }

  let end: DateTime;
  if (candidate.allDay) {
    // Google Calendar's all-day events use an *exclusive* end date — the
    // day after the event's actual last day. The model reports a natural
    // inclusive last day (a single-day event as start === end; a 3-day
    // event as start=day1, end=day3), so the exclusive end used below is
    // always that last-inclusive-day plus one — never the raw value —
    // whether or not the model supplied an explicit end at all. Applying
    // the +1 only in the no-end-given default (as an earlier version of
    // this function did) silently stored an explicit multi-day event one
    // day short and rejected a same-day event outright (start === end
    // both parsing to the same midnight makes `end <= start` true).
    const lastInclusiveDay = candidate.end ? DateTime.fromISO(candidate.end, { zone }) : start;
    if (!lastInclusiveDay.isValid) {
      return { ok: false, reason: "invalid_end" };
    }
    end = lastInclusiveDay.plus({ days: 1 });
  } else {
    end = candidate.end ? DateTime.fromISO(candidate.end, { zone, setZone: true }) : start.plus({ hours: 1 });
    if (!end.isValid) {
      return { ok: false, reason: "invalid_end" };
    }
  }

  const nowDt = DateTime.fromJSDate(now).setZone(zone);
  // An all-day event is a whole-day commitment, so "today" is still a
  // valid, actionable date even though the precise instant "now" is
  // necessarily later than midnight of that same day — comparing against
  // the exact instant (as a timed event must) would reject every same-day
  // deadline unconditionally, exactly the "due today" case CLAUDE.md calls
  // out as something this app must be able to act on.
  const earliestAllowedStart = candidate.allDay ? nowDt.startOf("day") : nowDt;
  if (start < earliestAllowedStart) {
    return { ok: false, reason: "past_event" };
  }
  if (end <= start) {
    return { ok: false, reason: "non_positive_duration" };
  }

  const durationHours = end.diff(start, "hours").hours;
  if (candidate.allDay && durationHours > MAX_ALL_DAY_DURATION_DAYS * 24) {
    return { ok: false, reason: "implausible_duration" };
  }
  if (!candidate.allDay && durationHours > MAX_TIMED_DURATION_HOURS) {
    return { ok: false, reason: "implausible_duration" };
  }

  return {
    ok: true,
    event: {
      title: candidate.title.trim(),
      startIso: candidate.allDay ? start.toISODate()! : start.toISO()!,
      endIso: candidate.allDay ? end.toISODate()! : end.toISO()!,
      allDay: candidate.allDay,
      timeZone: zone
    }
  };
}

/**
 * Validates that a short quoted/paraphrased sourceEvidence string is
 * actually present in the normalized message it claims to justify a date
 * from, guarding against a hallucinated or injected date.
 */
export function sourceEvidencePresent(sourceEvidence: string | null, normalizedBodyText: string | null): boolean {
  if (sourceEvidence === null || sourceEvidence.trim().length === 0) {
    return false;
  }
  const haystack = (normalizedBodyText ?? "").toLowerCase();
  return haystack.includes(sourceEvidence.trim().toLowerCase());
}
