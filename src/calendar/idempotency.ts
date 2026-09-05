import type { calendar_v3 } from "googleapis";
import { deterministicCalendarEventId, payloadHash } from "../core/ids.js";
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
    const { data } = await client.events.insert({
      calendarId: "primary",
      sendUpdates: "none",
      requestBody: plan.requestBody
    });
    return { kind: "inserted", event: data };
  } catch (error: unknown) {
    if (!isConflictError(error)) {
      throw error;
    }
    const { data: existing } = await client.events.get({
      calendarId: "primary",
      eventId: plan.eventId
    });
    const existingProvenance = existing.extendedProperties?.private?.["payloadHash"];
    if (existingProvenance === plan.provenance.payloadHash) {
      return { kind: "already_applied_by_this_app", event: existing };
    }
    if (existing.extendedProperties?.private?.["createdBy"] === CALENDAR_PROVENANCE_APP_ID) {
      // Same app, different payload for the same message/candidate slot: treat
      // as already applied under different content rather than a foreign collision.
      return { kind: "already_applied_by_this_app", event: existing };
    }
    return { kind: "collision", existing };
  }
}

function isConflictError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 409
  );
}
