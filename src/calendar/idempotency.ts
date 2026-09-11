import type { calendar_v3 } from "googleapis";
import { deterministicCalendarEventId, payloadHash } from "../core/ids.js";
import { apiErrorStatus, withGoogleApiRetry } from "../core/api-retry.js";
import type { ValidatedEvent } from "./event-policy.js";

export const CALENDAR_PROVENANCE_APP_ID = "gmail-agent-cli";

export interface CalendarProvenance {
  createdBy: string;
  gmailMessageId: string;
  gmailThreadId: string;
  classifierVersion: string;
  payloadHash: string;
}

export interface BuildEventInsertInput {
  accountHash: string;
  gmailMessageId: string;
  gmailThreadId: string;
  classifierVersion: string;
  candidateIndex: number;
  event: ValidatedEvent;
}

export interface EventInsertPlan {
  eventId: string;
  provenance: CalendarProvenance;
  requestBody: calendar_v3.Schema$Event;
}

/** Builds the deterministic-ID insert request. Never copies the email body. */
export function buildEventInsertPlan(input: BuildEventInsertInput): EventInsertPlan {
  const eventId = deterministicCalendarEventId({
    accountHash: input.accountHash,
    gmailMessageId: input.gmailMessageId,
    candidateIndex: input.candidateIndex
  });

  const hash = payloadHash({
    title: input.event.title,
    startIso: input.event.startIso,
    endIso: input.event.endIso,
    allDay: input.event.allDay,
    timeZone: input.event.timeZone
  });

  const provenance: CalendarProvenance = {
    createdBy: CALENDAR_PROVENANCE_APP_ID,
    gmailMessageId: input.gmailMessageId,
    gmailThreadId: input.gmailThreadId,
    classifierVersion: input.classifierVersion,
    payloadHash: hash
  };

  const requestBody: calendar_v3.Schema$Event = {
    id: eventId,
    summary: input.event.title,
    visibility: "private",
    start: input.event.allDay
      ? { date: input.event.startIso }
      : { dateTime: input.event.startIso, timeZone: input.event.timeZone },
    end: input.event.allDay
      ? { date: input.event.endIso }
      : { dateTime: input.event.endIso, timeZone: input.event.timeZone },
    description: `Created from a Gmail message by ${CALENDAR_PROVENANCE_APP_ID}. Source: gmail-message-id ${input.gmailMessageId}.`,
    extendedProperties: {
      private: { ...provenance }
    }
  };

  return { eventId, provenance, requestBody };
}

export type InsertOutcome =
  | { kind: "inserted"; event: calendar_v3.Schema$Event }
  | { kind: "already_applied_by_this_app"; event: calendar_v3.Schema$Event }
  | { kind: "collision"; existing: calendar_v3.Schema$Event }
  | { kind: "ambiguous_retry" };

/**
 * Inserts the event with its deterministic ID. On HTTP 409, fetches that ID:
 * matching private provenance means the first attempt already succeeded;
 * different provenance is a real collision requiring review.
 */
export async function insertIdempotentEvent(
  client: calendar_v3.Calendar,
  plan: EventInsertPlan
): Promise<InsertOutcome> {
  try {
    const { data } = await withGoogleApiRetry(() =>
      client.events.insert({
        calendarId: "primary",
        sendUpdates: "none",
        requestBody: plan.requestBody
      }), {}, 1, "calendar.events.insert"
    );
    return { kind: "inserted", event: data };
  } catch (error: unknown) {
    if (!isConflictError(error)) {
      throw error;
    }
    let existing: calendar_v3.Schema$Event;
    try {
      const response = await withGoogleApiRetry(() =>
        client.events.get({
          calendarId: "primary",
          eventId: plan.eventId
        }), {}, 1, "calendar.events.get"
      );
      existing = response.data;
    } catch (getError) {
      if (apiErrorStatus(getError) !== 404) throw getError;
      // Google reserves the ID of a deleted event, so an insert can conflict
      // with an ID that then cannot be fetched. Nothing can be concluded
      // about the remote state from that, and reporting a hard failure would
      // make every later run repeat it forever. The deterministic ID makes a
      // retry safe: it can only ever resolve to this same event.
      return { kind: "ambiguous_retry" };
    }
    const existingProvenance = existing.extendedProperties?.private?.["payloadHash"];
    if (existingProvenance === plan.provenance.payloadHash) {
      return { kind: "already_applied_by_this_app", event: existing };
    }
    // Matching payload hash is the ONLY case that means "this exact
    // attempt already succeeded." Same app, different payload (e.g. the
    // message got reclassified with a corrected date, so the candidate at
    // this same message/candidate slot changed) is exactly the case this
    // function's own contract calls a collision requiring review — a
    // prior version of this code treated same-createdBy specially and
    // silently kept serving the stale first event, with no review flag
    // ever surfaced, whenever content changed between runs.
    return { kind: "collision", existing };
  }
}

function isConflictError(error: unknown): boolean {
  return apiErrorStatus(error) === 409;
}
