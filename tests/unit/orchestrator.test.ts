import { describe, expect, it } from "vitest";
import { runWorkScan } from "../../src/core/orchestrator.js";
import { SystemClock } from "../../src/core/clock.js";
import type { Classifier } from "../../src/ai/classifier.js";
import type { AssessmentResult, NormalizedMessage, RuleGroup } from "../../src/core/models.js";
import type { GmailClient } from "../../src/gmail/client.js";

interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: { name: string; value: string }[];
  snippet?: string;
}

function fakeClient(messages: FakeMessage[]): GmailClient {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const inboxIds = messages.filter((m) => m.labelIds.includes("INBOX"));
  const spamIds = messages.filter((m) => m.labelIds.includes("SPAM"));

  const client = {
    users: {
      getProfile: async () => ({ data: { emailAddress: "me@example.com", historyId: "100" } }),
      messages: {
        list: async ({ labelIds }: { labelIds: string[] }) => {
          const source = labelIds.includes("SPAM") ? spamIds : inboxIds;
          return { data: { messages: source.map((m) => ({ id: m.id, threadId: m.threadId })) } };
        },
        get: async ({ id }: { id: string }) => {
          const m = byId.get(id)!;
          return {
            data: {
              id: m.id,
              threadId: m.threadId,
              historyId: "1",
              internalDate: "1000",
              labelIds: m.labelIds,
              snippet: m.snippet ?? "",
              payload: { headers: m.headers }
            }
          };
        }
      }
    }
  };
  return client as unknown as GmailClient;
}

class FixedClassifier implements Classifier {
  constructor(private readonly result: AssessmentResult) {}
  async assess(_message: NormalizedMessage): Promise<AssessmentResult> {
    return this.result;
  }
}

const NEVER_CALLED_CLASSIFIER: Classifier = {
  async assess() {
    throw new Error("classifier should not have been called for a bypassed message");
  }
};

function baseDeps(overrides: Partial<Parameters<typeof runWorkScan>[0]> = {}) {
  return {
    gmailClient: fakeClient([]),
    classifier: NEVER_CALLED_CLASSIFIER,
    ruleGroups: [] as RuleGroup[],
    userEmail: "me@example.com",
    userTimezone: "UTC",
    clock: new SystemClock(),
    concurrency: { gmailReads: 5, aiCalls: 2 },
    ...overrides
  };
}

describe("runWorkScan", () => {
  it("trashes unprotected native spam without calling the classifier", async () => {
    const client = fakeClient([
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["SPAM"],
        headers: [{ name: "From", value: "spammer@example.com" }]
      }
    ]);
    const { outcomes } = await runWorkScan(baseDeps({ gmailClient: client }));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.decision.actions).toEqual([{ type: "trash", reasonCode: "native_spam" }]);
  });

  it("archives a read inbox message using the classifier's assessment", async () => {
    const client = fakeClient([
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX"], // no UNREAD => read
        headers: [{ name: "From", value: "person@example.com" }]
      }
    ]);
    const classifier = new FixedClassifier({
      ok: false,
      unavailable: { reason: "not_configured", detail: null }
    });
    const { outcomes, summary } = await runWorkScan(baseDeps({ gmailClient: client, classifier }));
    expect(outcomes[0]!.decision.actions).toEqual([{ type: "archive", reasonCode: "read_non_trash" }]);
    expect(summary.archivedCount).toBe(1);
  });

  it("downgrades a calendar_create action with an invalid/past date to Review instead of executing it", async () => {
    const client = fakeClient([
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "UNREAD"],
        headers: [{ name: "From", value: "person@example.com" }]
      }
    ]);
    const classifier = new FixedClassifier({
      ok: true,
      assessment: {
        kind: "transactional_important",
        confidence: 0.99,
        importanceScore: 0.1,
        importanceConfidence: 0.1,
        summary: "test",
        reasonCodes: [],
        event: {
          intent: "create",
          confidence: 0.99,
          title: "Old event",
          start: "2000-01-01T10:00:00Z", // in the past
          end: "2000-01-01T11:00:00Z",
          allDay: false,
          timeZone: "UTC",
          location: null,
          sourceEvidence: null
        },
        classifierVersion: "test",
        promptVersion: "test",
        schemaVersion: "test"
      }
    });
    const { outcomes } = await runWorkScan(baseDeps({ gmailClient: client, classifier }));
    expect(outcomes[0]!.validatedEvent).toBeNull();
    expect(outcomes[0]!.decision.actions.some((a) => a.type === "calendar_create")).toBe(false);
    expect(outcomes[0]!.decision.needsReview).toBe(true);
  });

  it("flags Review when an important rule structurally matches but its auth binding fails", async () => {
    const client = fakeClient([
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "UNREAD"],
        headers: [{ name: "From", value: "boss@example.com" }]
        // No Authentication-Results header: structural match, auth fails.
      }
    ]);
    const ruleGroups: RuleGroup[] = [
      {
        id: "r1",
        accountHash: "a",
        categoryName: "Boss",
        action: "important",
        enabled: true,
        matchers: [
          {
            kind: "from_address",
            normalizedValue: "boss@example.com",
            authBinding: { mechanism: "dkim", domain: "example.com" }
          }
        ],
        createdAt: "now",
        updatedAt: "now"
      }
    ];
    const classifier = new FixedClassifier({
      ok: false,
      unavailable: { reason: "not_configured", detail: null }
    });
    const { outcomes } = await runWorkScan(baseDeps({ gmailClient: client, classifier, ruleGroups }));
    expect(outcomes[0]!.decision.needsReview).toBe(true);
    expect(outcomes[0]!.decision.reviewReason).toBe("important_rule_auth_failed");
    // The rule's auth check failing must not silently grant Star/Important.
    expect(outcomes[0]!.decision.actions.some((a) => a.type === "star")).toBe(false);
  });

  it("bounds classifier concurrency by aiCalls independently of gmailReads", async () => {
    const messages: FakeMessage[] = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      threadId: `t${i}`,
      labelIds: ["INBOX", "UNREAD"],
      headers: [{ name: "From", value: `person${i}@example.com` }]
    }));
    const client = fakeClient(messages);

    let inFlight = 0;
    let maxInFlight = 0;
    const trackingClassifier: Classifier = {
      async assess() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { ok: false, unavailable: { reason: "not_configured", detail: null } };
      }
    };

    // gmailReads is large enough that all 6 metadata fetches happen in one
    // batch; only aiCalls should limit how many classifier calls overlap.
    await runWorkScan(
      baseDeps({ gmailClient: client, classifier: trackingClassifier, concurrency: { gmailReads: 6, aiCalls: 2 } })
    );

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
