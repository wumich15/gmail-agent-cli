import type { AssessmentResult, NormalizedMessage } from "../core/models.js";
import type { ClassifyContext, Classifier } from "./classifier.js";

/**
 * Placeholder classifier used while the real OpenAI-backed classifier is
 * not implemented (or while `aiEnabled` is off). Never makes a network
 * call and always reports the assessment as unavailable, which the policy
 * engine treats as: no AI-derived trash/star/important/event mutation,
 * route to Review, but deterministic read-archiving still proceeds.
 */
export class NotConfiguredClassifier implements Classifier {
  async assess(_message: NormalizedMessage, _context: ClassifyContext): Promise<AssessmentResult> {
    return {
      ok: false,
      unavailable: {
        reason: "not_configured",
        detail: "AI classification is not implemented in this build."
      }
    };
  }
}
