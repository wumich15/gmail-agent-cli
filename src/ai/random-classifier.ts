import { EMAIL_ASSESSMENT_KINDS, EVENT_INTENTS, REASON_CODES } from "../core/models.js";
import type { AssessmentResult, EventIntent, NormalizedMessage } from "../core/models.js";
import type { ClassifyContext, Classifier } from "./classifier.js";

const CLASSIFIER_VERSION = "random-v1";

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function randomEventCandidate(intent: EventIntent, message: NormalizedMessage) {
  if (intent !== "create") {
    return {
      intent,
      confidence: Math.random(),
      title: null,
      start: null,
      end: null,
      allDay: false,
      timeZone: null,
      location: null,
      sourceEvidence: null
    };
  }
  // A plausible-shaped future event so the Calendar creation path can
  // actually be exercised end to end. Real validation still happens in
  // calendar/event-policy.ts before anything is ever inserted. sourceEvidence
  // must be a substring actually present in the message (see
  // calendar/event-policy.ts's sourceEvidencePresent), so it's taken from
  // the real snippet/body rather than invented, or omitted (event
  // discarded by that check) when there's no usable text to quote.
  const daysOut = 1 + Math.floor(Math.random() * 20);
  const start = new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000);
  const allDay = Math.random() < 0.3;
  const evidenceSource = (message.bodyText ?? message.snippet).trim();
  const sourceEvidence = evidenceSource.length > 0 ? evidenceSource.slice(0, 40) : null;
  return {
    intent,
    confidence: Math.random(),
    title: "Randomly generated placeholder event",
    start: allDay ? (start.toISOString().slice(0, 10) as string) : start.toISOString(),
    end: null,
    allDay,
    timeZone: allDay ? null : "UTC",
    location: null,
    sourceEvidence
  };
}

/**
 * A placeholder `Classifier` that returns a uniformly random, but
 * correctly-shaped, assessment for every message — no network call, no
 * API key, no real judgment. It exists purely to exercise the full
 * pipeline (trash/star/archive/calendar) end to end before a real
 * classifier is wired up.
 *
 * DO NOT run this against a mailbox you care about: its decisions are
 * meaningless. `commands/work.ts` prints a loud warning whenever it's
 * active.
 *
 * To replace it with a real filter: implement `Classifier` (see
 * `src/ai/classifier.ts`) — e.g. `src/ai/openai-classifier.ts` calling the
 * OpenAI Responses API with the schema in `src/ai/schema.ts` — and swap
 * the `new RandomClassifier()` construction in `commands/work.ts` for it.
 */
export class RandomClassifier implements Classifier {
  async assess(message: NormalizedMessage, _context: ClassifyContext): Promise<AssessmentResult> {
    const kind = pick(EMAIL_ASSESSMENT_KINDS);
    const eventIntent = Math.random() < 0.15 ? "create" : pick(EVENT_INTENTS.filter((i) => i !== "create"));

    return {
      ok: true,
      assessment: {
        kind,
        confidence: Math.random(),
        importanceScore: Math.random(),
        importanceConfidence: Math.random(),
        summary: `Randomly classified as "${kind}" (placeholder classifier, not a real judgment).`,
        reasonCodes: [pick(REASON_CODES)],
        event: randomEventCandidate(eventIntent, message),
        category: Math.random() < 0.3 ? pick(["Shopping", "Updates", "Receipts"]) : null,
        classifierVersion: CLASSIFIER_VERSION,
        promptVersion: "none",
        schemaVersion: "none"
      }
    };
  }
}
