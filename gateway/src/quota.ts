import { getFirestore } from "firebase-admin/firestore";
import type { QuotaConfig } from "./config.js";

/**
 * Per-user allowance, reserved before the provider call and reconciled after
 * it.
 *
 * Reservation is a single Firestore transaction over one counter document, so
 * a client running many classifications concurrently cannot race past the
 * limit by firing requests faster than a read-then-write could notice. The
 * reservation happens *before* the provider is called because the cost is
 * incurred by the call, not by its success: a request that times out
 * upstream still spent the publisher's money.
 *
 * Refunding a request the provider never accepted (an outright rejection, not
 * a timeout) is the one adjustment made afterwards. An ambiguous outcome is
 * deliberately left counted: over-counting costs the user a little allowance,
 * while under-counting costs the publisher real money and is the direction an
 * abusive client would try to push.
 *
 * Only counters live here. No prompt, no response, no token text, no address.
 */

export const USAGE_COLLECTION = "usage";

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

interface UsageDocument {
  minuteWindow?: number;
  minuteCount?: number;
  dayWindow?: string;
  dayCount?: number;
  monthWindow?: string;
  monthCount?: number;
  totalTokens?: number;
  updatedAt?: string;
}

function windows(now: Date): { minute: number; day: string; month: string } {
  const iso = now.toISOString();
  return {
    minute: Math.floor(now.getTime() / 60_000),
    day: iso.slice(0, 10),
    month: iso.slice(0, 7)
  };
}

/** Reserves one request against the per-minute, per-day, and per-month limits. */
export async function reserveRequest(userId: string, config: QuotaConfig, now = new Date()): Promise<void> {
  const document = getFirestore().collection(USAGE_COLLECTION).doc(userId);
  const current = windows(now);

  await getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(document);
    const data = (snapshot.data() as UsageDocument | undefined) ?? {};

    const minuteCount = data.minuteWindow === current.minute ? (data.minuteCount ?? 0) : 0;
    const dayCount = data.dayWindow === current.day ? (data.dayCount ?? 0) : 0;
    const monthCount = data.monthWindow === current.month ? (data.monthCount ?? 0) : 0;

    if (minuteCount >= config.requestsPerMinute) {
      throw new QuotaExceededError("Too many AI requests in the last minute.", 60);
    }
    if (dayCount >= config.requestsPerDay) {
      throw new QuotaExceededError("The daily included-AI allowance is used up.", 3_600);
    }
    if (monthCount >= config.requestsPerMonth) {
      throw new QuotaExceededError("The monthly included-AI allowance is used up.", 86_400);
    }

    transaction.set(
      document,
      {
        minuteWindow: current.minute,
        minuteCount: minuteCount + 1,
        dayWindow: current.day,
        dayCount: dayCount + 1,
        monthWindow: current.month,
        monthCount: monthCount + 1,
        updatedAt: now.toISOString()
      },
      { merge: true }
    );
  });
}

/**
 * Gives back a reservation for a request the provider provably never
 * accepted. Never called for a timeout or any other ambiguous outcome.
 */
export async function releaseReservation(userId: string, now = new Date()): Promise<void> {
  const document = getFirestore().collection(USAGE_COLLECTION).doc(userId);
  const current = windows(now);
  try {
    await getFirestore().runTransaction(async (transaction) => {
      const data = ((await transaction.get(document)).data() as UsageDocument | undefined) ?? {};
      transaction.set(
        document,
        {
          ...(data.minuteWindow === current.minute ? { minuteCount: Math.max(0, (data.minuteCount ?? 1) - 1) } : {}),
          ...(data.dayWindow === current.day ? { dayCount: Math.max(0, (data.dayCount ?? 1) - 1) } : {}),
          ...(data.monthWindow === current.month ? { monthCount: Math.max(0, (data.monthCount ?? 1) - 1) } : {})
        },
        { merge: true }
      );
    });
  } catch {
    // A failed refund only costs the user one request of allowance. It must
    // never turn into the error the caller reports, which would hide the real
    // provider failure behind a bookkeeping one.
  }
}

/** Records token usage for cost monitoring. Counts only; never any content. */
export async function recordTokens(userId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  try {
    const { FieldValue } = await import("firebase-admin/firestore");
    await getFirestore()
      .collection(USAGE_COLLECTION)
      .doc(userId)
      .set({ totalTokens: FieldValue.increment(tokens) }, { merge: true });
  } catch {
    // Cost telemetry is not worth failing a user's request over.
  }
}
