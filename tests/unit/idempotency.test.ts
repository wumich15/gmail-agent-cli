import { describe, expect, it } from "vitest";
import { buildEventInsertPlan, insertIdempotentEvent } from "../../src/calendar/idempotency.js";
import type { ValidatedEvent } from "../../src/calendar/event-policy.js";
import type { calendar_v3 } from "googleapis";

function event(overrides: Partial<ValidatedEvent> = {}): ValidatedEvent {
  return {
    title: "Dentist",
    startIso: "2099-06-01T10:00:00.000-00:00",
    endIso: "2099-06-01T11:00:00.000-00:00",
    allDay: false,
    timeZone: "UTC",
    ...overrides
  };
}

function plan(eventOverrides: Partial<ValidatedEvent> = {}) {
  return buildEventInsertPlan({
    accountHash: "acct-1",
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    classifierVersion: "test",
    candidateIndex: 0,
    event: event(eventOverrides)
  });
}

function conflictError(): unknown {
  return Object.assign(new Error("conflict"), { status: 409 });
}

describe("insertIdempotentEvent", () => {
  it("returns inserted on a clean insert", async () => {
    const client = {
      events: { insert: async () => ({ data: { id: "e1" } }) }
    } as unknown as calendar_v3.Calendar;
    const result = await insertIdempotentEvent(client, plan());
    expect(result.kind).toBe("inserted");
  });

  it("returns already_applied_by_this_app on a 409 with matching provenance payload hash", async () => {
    const p = plan();
    const client = {
      events: {
        insert: async () => {
          throw conflictError();
        },
        get: async () => ({
          data: { id: p.eventId, extendedProperties: { private: { ...p.provenance } } }
        })
      }
    } as unknown as calendar_v3.Calendar;
    const result = await insertIdempotentEvent(client, p);
    expect(result.kind).toBe("already_applied_by_this_app");
  });

  it("returns collision on a 409 from a foreign (non-app) event at the same ID", async () => {
    const p = plan();
    const client = {
      events: {
        insert: async () => {
          throw conflictError();
        },
        get: async () => ({ data: { id: p.eventId, extendedProperties: { private: { createdBy: "some-other-app" } } } })
      }
    } as unknown as calendar_v3.Calendar;
    const result = await insertIdempotentEvent(client, p);
    expect(result.kind).toBe("collision");
  });

  it("returns collision — not already_applied — on a 409 from this app's own event with a DIFFERENT payload hash", async () => {
    // Regression: same createdBy but a different payload (e.g. the
    // message was reclassified with a corrected date) used to be treated
    // as "already applied," silently keeping the stale first event with
    // no review flag ever surfaced — contradicting this function's own
    // documented contract that differing provenance is a collision.
    const p = plan();
    const staleP = plan({ title: "Old title" });
    const client = {
      events: {
        insert: async () => {
          throw conflictError();
        },
        get: async () => ({
          data: {
            id: p.eventId,
            extendedProperties: { private: { ...staleP.provenance } }
          }
        })
      }
    } as unknown as calendar_v3.Calendar;
    const result = await insertIdempotentEvent(client, p);
    expect(result.kind).toBe("collision");
  });

  it("rethrows a non-409 error rather than swallowing it", async () => {
    // Status 400 (not 429/5xx) so withApiRetry's default retry budget
    // doesn't turn this into a slow, multi-second test.
    const client = {
      events: {
        insert: async () => {
          throw Object.assign(new Error("boom"), { status: 400 });
        }
      }
    } as unknown as calendar_v3.Calendar;
    await expect(insertIdempotentEvent(client, plan())).rejects.toThrow("boom");
  });
});
