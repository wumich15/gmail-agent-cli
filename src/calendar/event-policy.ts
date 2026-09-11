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

  // A start with no time in it is a whole-day commitment however the model
  // labelled it. Treating "2026-09-18" as a timed event put a real
  // appointment on the calendar at midnight, which is both wrong and, for
  // anything later today, rejected outright as being in the past.
  const allDay = candidate.allDay || isDateOnly(candidate.start);

  const start = allDay
    ? DateTime.fromISO(candidate.start, { zone })
    : DateTime.fromISO(candidate.start, { zone, setZone: true });
  if (!start.isValid) {
    return { ok: false, reason: "invalid_start" };
  }

  let end: DateTime;
  if (allDay) {
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
    end = lastInclusiveDay.isValid ? lastInclusiveDay.plus({ days: 1 }) : start.plus({ days: 1 });
  } else {
    const stated = candidate.end ? DateTime.fromISO(candidate.end, { zone, setZone: true }) : null;
    end = stated?.isValid ? stated : start.plus({ hours: 1 });
  }

  // The commitment the user cares about is when it *starts*. An end the
  // model got wrong — before the start, or implausibly far after it — is a
  // reason to fall back to a sensible default length, not to throw away a
  // date the message really does state. A bad start is still fatal.
  const statedDurationHours = end.diff(start, "hours").hours;
  if (statedDurationHours <= 0 || statedDurationHours > maxDurationHours(allDay)) {
    end = allDay ? start.plus({ days: 1 }) : start.plus({ hours: 1 });
  }

  const nowDt = DateTime.fromJSDate(now).setZone(zone);
  // An all-day event is a whole-day commitment, so "today" is still a
  // valid, actionable date even though the precise instant "now" is
  // necessarily later than midnight of that same day — comparing against
  // the exact instant (as a timed event must) would reject every same-day
  // deadline unconditionally, exactly the "due today" case CLAUDE.md calls
  // out as something this app must be able to act on.
  const earliestAllowedStart = allDay ? nowDt.startOf("day") : nowDt;
  if (start < earliestAllowedStart) {
    return { ok: false, reason: "past_event" };
  }
  return {
    ok: true,
    event: {
      title: candidate.title.trim(),
      startIso: allDay ? start.toISODate()! : start.toISO()!,
      endIso: allDay ? end.toISODate()! : end.toISO()!,
      allDay,
      timeZone: zone
    }
  };
}

function maxDurationHours(allDay: boolean): number {
  return allDay ? MAX_ALL_DAY_DURATION_DAYS * 24 : MAX_TIMED_DURATION_HOURS;
}

/** True for "2026-09-18" and false for anything carrying a time of day. */
function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * Validates that the quoted sourceEvidence really appears in the message it
 * claims to justify a date from, guarding against a hallucinated or injected
 * date.
 *
 * The comparison is whitespace-insensitive and spans the subject as well as
 * the body. Both matter in practice: plenty of real mail states the date in
 * the subject alone ("Your appointment — Thu Sep 18, 2pm"), and a quote of
 * body text that wrapped across a line arrives with a space where the body
 * has a newline. Neither is a hallucination, but an exact substring match on
 * the body alone rejected both, silently dropping real appointments. The
 * check still requires the model's own words to appear, in order, in text the
 * sender actually wrote.
 */
export function sourceEvidencePresent(
  sourceEvidence: string | null,
  normalizedBodyText: string | null,
  subject?: string | null
): boolean {
  if (sourceEvidence === null || sourceEvidence.trim().length === 0) {
    return false;
  }
  const needle = collapseForEvidence(sourceEvidence);
  if (needle.length === 0) return false;
  const haystack = collapseForEvidence(`${subject ?? ""}\n${normalizedBodyText ?? ""}`);
  return haystack.includes(needle);
}

function collapseForEvidence(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
