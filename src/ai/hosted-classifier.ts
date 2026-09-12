import { HOSTED_LIMITS } from "./hosted-contract.js";
import { HostedAiError, type HostedAiClient } from "./hosted-client.js";
import { extractClassificationFacts } from "./prompt.js";
import { mapFlagsToAssessment } from "./assessment-mapping.js";
import type { ClassifyContext, Classifier } from "./classifier.js";
import type { AssessmentResult, NormalizedMessage } from "../core/models.js";

/**
 * Classifier backed by the publisher's AI gateway.
 *
 * It is the same untrusted analysis component as the direct-OpenAI
 * classifier, one step further removed: this process sends typed, bounded
 * facts about one message and receives the same typed flags back. It holds no
 * provider key, cannot name a model, and cannot ask for anything but a
 * classification. The deterministic policy engine downstream is unchanged.
 *
 * Once the run has learned that the allowance is exhausted or the session is
 * unusable, every remaining message short-circuits to the same unavailable
 * result instead of making hundreds of calls that are already known to fail —
 * a mailbox with a thousand unresolved messages should not produce a thousand
 * identical 429s.
 */
export class HostedClassifier implements Classifier {
  private terminal: { reason: "not_configured" | "provider_unavailable"; detail: string } | null = null;

  constructor(
    private readonly client: HostedAiClient,
    private readonly classifierVersion: string
  ) {}

  async assess(message: NormalizedMessage, context: ClassifyContext): Promise<AssessmentResult> {
    if (this.terminal) {
      return { ok: false, unavailable: { ...this.terminal } };
    }
    const facts = extractClassificationFacts(message, {
      ...(context.userTimeZone !== undefined ? { userTimeZone: context.userTimeZone } : {})
    });
    try {
      const response = await this.client.classify({
        message: {
          fromDisplayName: bound(facts.fromDisplayName, HOSTED_LIMITS.displayNameChars),
          fromAddress: bound(facts.fromAddress, HOSTED_LIMITS.addressChars),
          subject: facts.subject.slice(0, HOSTED_LIMITS.subjectChars),
          sentDate: facts.sentDate,
          userTimeZone: bound(facts.userTimeZone, 100),
          bulkSignal: facts.bulkSignal,
          content: facts.content.slice(0, HOSTED_LIMITS.contentChars),
          contentIsFullBody: facts.contentIsFullBody,
          truncated: facts.truncated || facts.content.length > HOSTED_LIMITS.contentChars
        },
        existingLabels: (context.existingLabels ?? [])
          .slice(0, HOSTED_LIMITS.labelCount)
          .map((name) => name.slice(0, HOSTED_LIMITS.labelNameChars))
      });

      if (!response.ok) {
        return { ok: false, unavailable: { reason: response.reason, detail: response.detail } };
      }
      return {
        ok: true,
        assessment: mapFlagsToAssessment(response.flags, message, this.classifierVersion)
      };
    } catch (error) {
      if (error instanceof HostedAiError) {
        // "auth" and "contract" cannot resolve themselves inside this run, and
        // "quota" will not until the window rolls over; all three become a
        // run-wide stop so the remaining messages fail fast and land in
        // Review rather than each paying a full retry budget first.
        const reason = error.kind === "unavailable" ? "provider_unavailable" : "not_configured";
        if (error.kind !== "unavailable") {
          this.terminal = { reason, detail: error.message };
        }
        return { ok: false, unavailable: { reason, detail: error.message } };
      }
      return {
        ok: false,
        unavailable: { reason: "provider_unavailable", detail: error instanceof Error ? error.message : String(error) }
      };
    }
  }

  /** Set once the run hits a condition no later message can recover from. Surfaced in the summary. */
  stoppedBecause(): string | null {
    return this.terminal?.detail ?? null;
  }
}

function bound(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}
