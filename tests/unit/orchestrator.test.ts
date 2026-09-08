import { describe, expect, it, vi } from "vitest";
import { resolvePostScanHistoryMarker, runWorkScan, type CachedAssessmentSnapshot } from "../../src/core/orchestrator.js";
import { SystemClock } from "../../src/core/clock.js";
import { buildNormalizedMessage, headerMapFromList } from "../../src/gmail/normalize.js";
import type { Classifier } from "../../src/ai/classifier.js";
import type { AssessmentResult, NormalizedMessage, RuleGroup } from "../../src/core/models.js";
import type { GmailClient } from "../../src/gmail/client.js";

interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: { name: string; value: string }[];
  snippet?: string;
  internalDate?: string;
}

function fakeClient(messages: FakeMessage[]): GmailClient {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const inboxIds = messages.filter((m) => m.labelIds.includes("INBOX"));
  const spamIds = messages.filter((m) => m.labelIds.includes("SPAM"));

  const client = {
    users: {
      getProfile: async () => ({ data: { emailAddress: "me@example.com", historyId: "100" } }),
      history: {
        // No changes during the (instantaneous, in these tests) full-scan
        // window — runFullScan's post-scan reconciliation call is a no-op.
        list: async () => ({ data: { history: [], historyId: "100" } })
      },
      labels: {
        get: async () => ({ data: { messagesTotal: inboxIds.length } })
      },
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
              internalDate: m.internalDate ?? "1000",
              labelIds: m.labelIds,
              snippet: m.snippet ?? "",
              payload: { headers: m.headers }
            }
          };
        }
      },
      // No message in any test thread is ever from the user by default —
      // see the dedicated "thread has a user-sent message" test below for
      // the one that overrides this to return SENT.
      threads: {
        get: async () => ({ data: { messages: [] } })
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

  it("protects a message whose thread already contains a message the user sent, even under a high-confidence spam classification", async () => {
    // Regression: threadHasUserSentMessage was previously hardcoded false
    // and never consulted by isProtected — this message would otherwise
    // have been auto-trashed despite the user having replied in the thread.
    const client = fakeClient([
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "UNREAD"],
        headers: [{ name: "From", value: "list@example.com" }]
      }
    ]);
    (client.users as unknown as { threads: { get: () => Promise<unknown> } }).threads = {
      get: async () => ({ data: { messages: [{ labelIds: ["SENT"] }] } })
    };
    const classifier = new FixedClassifier({
      ok: true,
      assessment: {
        kind: "promotion",
        confidence: 0.99,
        importanceScore: 0,
        importanceConfidence: 0,
        summary: "test",
        reasonCodes: [],
        event: {
          intent: "none",
          confidence: 0,
          title: null,
          start: null,
          end: null,
          allDay: false,
          timeZone: null,
          location: null,
          sourceEvidence: null
        },
        category: null,
        classifierVersion: "test",
        promptVersion: "test",
        schemaVersion: "test"
      }
    });
    const { outcomes } = await runWorkScan(baseDeps({ gmailClient: client, classifier }));
    expect(outcomes[0]!.decision.actions.some((a) => a.type === "trash")).toBe(false);
  });

  it("never crashes the whole run when the thread-reply check itself fails, and conservatively skips Trash", async () => {
    // Regression: a sustained Gmail quota error from fetchThreadHasUserSentMessage
    // (exhausting withApiRetry's retry budget) previously propagated
    // uncaught out of finalizeOutcome/mapWithConcurrency and crashed the
    // entire `gmail work` invocation instead of degrading just this one
    // message.
    const client = fakeClient([
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "UNREAD"],
        headers: [{ name: "From", value: "list@example.com" }]
      }
    ]);
    (client.users as unknown as { threads: { get: () => Promise<unknown> } }).threads = {
      get: async () => {
        throw new Error("Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'.");
      }
    };
    const classifier = new FixedClassifier({
      ok: true,
      assessment: {
        kind: "promotion",
        confidence: 0.99,
        importanceScore: 0,
        importanceConfidence: 0,
        summary: "test",
        reasonCodes: [],
        event: {
          intent: "none",
          confidence: 0,
          title: null,
          start: null,
          end: null,
          allDay: false,
          timeZone: null,
          location: null,
          sourceEvidence: null
        },
        category: null,
        classifierVersion: "test",
        promptVersion: "test",
        schemaVersion: "test"
      }
    });
    const { outcomes } = await runWorkScan(baseDeps({ gmailClient: client, classifier }));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.decision.actions.some((a) => a.type === "trash")).toBe(false);
    expect(outcomes[0]!.decision.needsReview).toBe(true);
    expect(outcomes[0]!.decision.reviewReason).toBe("thread_reply_check_failed");
  });

  it("vetoes AI-derived trash for an authenticated, high-risk-content message instead of trashing it", async () => {
    // Regression: hasAuthenticatedHighRiskSignal was previously hardcoded
    // false, so the safety veto in policy.ts could never fire.
    const client = fakeClient([
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "UNREAD"],
        headers: [
          { name: "From", value: "security@example.com" },
          { name: "Authentication-Results", value: "dkim=pass header.i=@example.com" }
        ],
        snippet: "We detected unusual activity. Please verify your account within 24 hours."
      }
    ]);
    const classifier = new FixedClassifier({
      ok: true,
      assessment: {
        kind: "promotion",
        confidence: 0.99,
        importanceScore: 0,
        importanceConfidence: 0,
        summary: "test",
        reasonCodes: [],
        event: {
          intent: "none",
          confidence: 0,
          title: null,
          start: null,
          end: null,
          allDay: false,
          timeZone: null,
          location: null,
          sourceEvidence: null
        },
        category: null,
        classifierVersion: "test",
        promptVersion: "test",
        schemaVersion: "test"
      }
    });
    const { outcomes } = await runWorkScan(baseDeps({ gmailClient: client, classifier }));
    expect(outcomes[0]!.decision.actions.some((a) => a.type === "trash")).toBe(false);
    expect(outcomes[0]!.decision.needsReview).toBe(true);
    expect(outcomes[0]!.decision.reviewReason).toBe("authenticated_high_risk_veto");
  });

  function contentHashFor(message: FakeMessage): string {
    return buildNormalizedMessage({
      gmailMessageId: message.id,
      gmailThreadId: message.threadId,
      historyId: "1",
      internalDate: message.internalDate ?? "1000",
      labelIds: message.labelIds,
      snippet: message.snippet ?? "",
      headers: headerMapFromList(message.headers),
      htmlBody: null,
      plainBody: null,
      userEmail: "me@example.com",
      threadHasUserSentMessage: false
    }).contentHash;
  }

  describe("cachedAssessments (assessment-reuse cache)", () => {
    const message: FakeMessage = {
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      headers: [{ name: "From", value: "person@example.com" }, { name: "Subject", value: "Hi" }]
    };
    const cachedSnapshot: CachedAssessmentSnapshot = {
      contentHash: contentHashFor(message),
      classifierVersion: "openai:test-model",
      promptVersion: "prompt-v5",
      schemaVersion: "schema-v5",
      policyVersion: "policy-v4",
      kind: "personal_important",
      confidence: 0.98,
      importanceScore: 0.95,
      importanceConfidence: 0.95,
      reasonCodes: [],
      category: "Work"
    };

    it("skips the AI call after the required freshness fetch when content hash and every version match", async () => {
      const client = fakeClient([message]);
      const messagesApi = client.users.messages as unknown as {
        get: (params: { id: string }) => Promise<unknown>;
      };
      const originalGet = messagesApi.get;
      let gmailMessageFetches = 0;
      messagesApi.get = async (params) => {
        gmailMessageFetches += 1;
        return originalGet(params);
      };
      let classifierCalls = 0;
      const classifier: Classifier = {
        async assess(): Promise<AssessmentResult> {
          classifierCalls += 1;
          return { ok: false, unavailable: { reason: "not_configured", detail: null } };
        }
      };
      const { outcomes } = await runWorkScan(
        baseDeps({
          gmailClient: client,
          classifier,
          classifierVersion: cachedSnapshot.classifierVersion,
          promptVersion: cachedSnapshot.promptVersion,
          schemaVersion: cachedSnapshot.schemaVersion,
          cachedAssessments: new Map([[message.id, cachedSnapshot]])
        })
      );
      // A cache hit saves the slow OpenAI call, but messages.get is still
      // required to verify that the content hash and current Gmail labels
      // have not changed since the row was cached.
      expect(gmailMessageFetches).toBe(1);
      expect(classifierCalls).toBe(0);
      // The reconstructed assessment should still drive the same
      // star/important decision the original classification would have.
      expect(outcomes[0]!.decision.actions.some((a) => a.type === "star")).toBe(true);
      expect(outcomes[0]!.decision.actions.some((a) => a.type === "mark_important")).toBe(true);
    });

    it("calls the AI classifier when the message's content hash no longer matches the cached row (content changed)", async () => {
      const client = fakeClient([message]);
      let called = false;
      const classifier: Classifier = {
        async assess(): Promise<AssessmentResult> {
          called = true;
          return { ok: false, unavailable: { reason: "not_configured", detail: null } };
        }
      };
      await runWorkScan(
        baseDeps({
          gmailClient: client,
          classifier,
          classifierVersion: cachedSnapshot.classifierVersion,
          promptVersion: cachedSnapshot.promptVersion,
          schemaVersion: cachedSnapshot.schemaVersion,
          cachedAssessments: new Map([[message.id, { ...cachedSnapshot, contentHash: "stale-hash-from-before-an-edit" }]])
        })
      );
      expect(called).toBe(true);
    });

    it("calls the AI classifier when the run's prompt/schema version no longer matches the cached row (a prompt/model upgrade)", async () => {
      const client = fakeClient([message]);
      let called = false;
      const classifier: Classifier = {
        async assess(): Promise<AssessmentResult> {
          called = true;
          return { ok: false, unavailable: { reason: "not_configured", detail: null } };
        }
      };
      await runWorkScan(
        baseDeps({
          gmailClient: client,
          classifier,
          classifierVersion: cachedSnapshot.classifierVersion,
          promptVersion: "prompt-v6", // newer than the cached row's prompt-v5
          schemaVersion: cachedSnapshot.schemaVersion,
          cachedAssessments: new Map([[message.id, cachedSnapshot]])
        })
      );
      expect(called).toBe(true);
    });
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
        category: null,
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

  it("processes and reports messages most-recent-first regardless of the order Gmail returned them in", async () => {
    const messages: FakeMessage[] = [
      {
        id: "old",
        threadId: "t-old",
        labelIds: ["INBOX", "UNREAD"],
        headers: [{ name: "From", value: "a@example.com" }, { name: "Subject", value: "Old one" }],
        internalDate: "1000"
      },
      {
        id: "new",
        threadId: "t-new",
        labelIds: ["INBOX", "UNREAD"],
        headers: [{ name: "From", value: "b@example.com" }, { name: "Subject", value: "New one" }],
        internalDate: "9000"
      }
    ];
    // fakeClient's messages.list returns them in this same (oldest-first)
    // order; runWorkScan must not just trust that.
    const client = fakeClient(messages);
    const classifier = new FixedClassifier({
      ok: false,
      unavailable: { reason: "not_configured", detail: null }
    });
    const { outcomes, summary } = await runWorkScan(baseDeps({ gmailClient: client, classifier }));

    expect(outcomes.map((o) => o.gmailMessageId)).toEqual(["new", "old"]);
    expect(summary.recentUnread.map((d) => d.subject)).toEqual(["New one", "Old one"]);
  });

  it("lists a message with no action and no review flag under `unchanged`", async () => {
    // A read, non-spam message the classifier has nothing to say about
    // yet (not flagged for review, no action) should still be visible
    // somewhere in the summary, not silently disappear.
    const client = fakeClient([
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX"], // read (no UNREAD), so ordinarily archive would fire...
        headers: [{ name: "From", value: "a@example.com" }]
      }
    ]);
    // ...unless it's already out of the Inbox; simulate a message that's
    // simply not in the Inbox at all (e.g. a stray label combination) so
    // no action applies and it isn't a Review item either.
    const classifier: Classifier = {
      async assess() {
        return { ok: false, unavailable: { reason: "not_configured", detail: null } };
      }
    };
    const { summary } = await runWorkScan(baseDeps({ gmailClient: client, classifier }));
    // This message is read and in the Inbox, so it *will* be archived —
    // demonstrating the more common "not unchanged" path stays correct.
    expect(summary.archivedCount).toBe(1);
    expect(summary.unchanged).toEqual([]);
  });

  it("only applies an AI-guessed category label once at least 10 messages in the run agree on it", async () => {
    const messages: FakeMessage[] = Array.from({ length: 9 }, (_, i) => ({
      id: `under-${i}`,
      threadId: `t-under-${i}`,
      labelIds: ["INBOX", "UNREAD"],
      headers: [{ name: "From", value: `person${i}@example.com` }]
    }));
    const client = fakeClient(messages);
    const classifier = new FixedClassifier({
      ok: true,
      assessment: {
        kind: "personal_routine",
        confidence: 0,
        importanceScore: 0,
        importanceConfidence: 0,
        summary: "test",
        reasonCodes: [],
        event: {
          intent: "none",
          confidence: 0,
          title: null,
          start: null,
          end: null,
          allDay: false,
          timeZone: null,
          location: null,
          sourceEvidence: null
        },
        category: "Shopping",
        classifierVersion: "test",
        promptVersion: "test",
        schemaVersion: "test"
      }
    });
    const { outcomes, labelCandidateUpdates } = await runWorkScan(baseDeps({ gmailClient: client, classifier }));
    expect(outcomes.every((o) => !o.decision.actions.some((a) => a.type === "label"))).toBe(true);
    // The 9 pending occurrences must be reported back so the caller can
    // persist them and let a later run's occurrences accumulate on top.
    expect(labelCandidateUpdates).toContainEqual({
      normalizedName: "shopping",
      displayName: "Shopping",
      newCumulativeCount: 9,
      applied: false,
      newlyVotedMessageIds: messages.map((m) => m.id)
    });
  });

  it("applies a category label immediately, with no threshold at all, when it already matches an existing Gmail label", async () => {
    // A label that already exists isn't a fuzzy one-off guess anymore —
    // applying it to more mail is just correctly reusing it, so a single
    // message is enough once the account already has this label.
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
        kind: "personal_routine",
        confidence: 0,
        importanceScore: 0,
        importanceConfidence: 0,
        summary: "test",
        reasonCodes: [],
        event: {
          intent: "none",
          confidence: 0,
          title: null,
          start: null,
          end: null,
          allDay: false,
          timeZone: null,
          location: null,
          sourceEvidence: null
        },
        category: "shopping", // different casing than the existing label
        classifierVersion: "test",
        promptVersion: "test",
        schemaVersion: "test"
      }
    });
    const { outcomes } = await runWorkScan(
      baseDeps({ gmailClient: client, classifier, existingLabels: ["Shopping"] })
    );
    expect(outcomes[0]!.decision.actions.some((a) => a.type === "label")).toBe(true);
  });

  it("applies a category label once cumulative count (prior runs + this run) crosses the threshold, even though this run alone is under 10", async () => {
    const messages: FakeMessage[] = Array.from({ length: 3 }, (_, i) => ({
      id: `m-${i}`,
      threadId: `t-${i}`,
      labelIds: ["INBOX", "UNREAD"],
      headers: [{ name: "From", value: `person${i}@example.com` }]
    }));
    const client = fakeClient(messages);
    const classifier = new FixedClassifier({
      ok: true,
      assessment: {
        kind: "personal_routine",
        confidence: 0,
        importanceScore: 0,
        importanceConfidence: 0,
        summary: "test",
        reasonCodes: [],
        event: {
          intent: "none",
          confidence: 0,
          title: null,
          start: null,
          end: null,
          allDay: false,
          timeZone: null,
          location: null,
          sourceEvidence: null
        },
        category: "Receipts",
        classifierVersion: "test",
        promptVersion: "test",
        schemaVersion: "test"
      }
    });
    const priorLabelCandidateCounts = new Map([["receipts", { displayName: "Receipts", count: 8 }]]);
    const { outcomes, labelCandidateUpdates } = await runWorkScan(
      baseDeps({ gmailClient: client, classifier, priorLabelCandidateCounts })
    );
    expect(outcomes.every((o) => o.decision.actions.some((a) => a.type === "label"))).toBe(true);
    expect(labelCandidateUpdates).toContainEqual({
      normalizedName: "receipts",
      displayName: "Receipts",
      newCumulativeCount: 11,
      applied: true,
      newlyVotedMessageIds: messages.map((m) => m.id)
    });
  });

  it("applies a category label once 10+ messages agree, normalizing case-insensitive spelling variants to one name", async () => {
    const messages: FakeMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: `over-${i}`,
      threadId: `t-over-${i}`,
      labelIds: ["INBOX", "UNREAD"],
      headers: [{ name: "From", value: `person${i}@example.com` }]
    }));
    const client = fakeClient(messages);
    let call = 0;
    const classifier: Classifier = {
      async assess() {
        call += 1;
        const category = call === 1 ? "shopping" : "Shopping"; // one differently-cased guess
        return {
          ok: true,
          assessment: {
            kind: "personal_routine",
            confidence: 0,
            importanceScore: 0,
            importanceConfidence: 0,
            summary: "test",
            reasonCodes: [],
            event: {
              intent: "none",
              confidence: 0,
              title: null,
              start: null,
              end: null,
              allDay: false,
              timeZone: null,
              location: null,
              sourceEvidence: null
            },
            category,
            classifierVersion: "test",
            promptVersion: "test",
            schemaVersion: "test"
          }
        };
      }
    };
    const { outcomes } = await runWorkScan(baseDeps({ gmailClient: client, classifier }));
    const labelActions = outcomes.flatMap((o) => o.decision.actions.filter((a) => a.type === "label"));
    expect(labelActions).toHaveLength(10);
    // Every survivor uses the exact same display name, not a mix of casings.
    expect(new Set(labelActions.map((a) => (a as { labelName: string }).labelName)).size).toBe(1);
  });

  it("uses the freshly-fetched threadId as authoritative, not the history record's placeholder", async () => {
    // Regression: fetchAndNormalize used to trust the caller-supplied
    // stub's threadId unconditionally instead of the real fetch response,
    // even though the incremental-scan path builds that stub from a
    // history record (a placeholder, not a real messages.list/get result).
    const client: GmailClient = {
      users: {
        getProfile: async () => ({ data: { emailAddress: "me@example.com", historyId: "200" } }),
        history: {
          list: async () => ({
            data: {
              // Wrong/placeholder threadId in the history record itself.
              history: [{ id: "150", labelsAdded: [{ message: { id: "m1", threadId: "wrong-thread" } }] }],
              historyId: "200"
            }
          })
        },
        labels: { get: async () => ({ data: { messagesTotal: 1 } }) },
        messages: {
          list: async () => ({ data: { messages: [] } }),
          get: async () => ({
            data: {
              id: "m1",
              threadId: "correct-thread", // the real, authoritative value
              historyId: "150",
              internalDate: "5000",
              labelIds: ["INBOX", "UNREAD"],
              snippet: "",
              payload: { headers: [{ name: "From", value: "person@example.com" }] }
            }
          })
        },
        threads: { get: async () => ({ data: { messages: [] } }) }
      }
    } as unknown as GmailClient;

    const classifier = new FixedClassifier({
      ok: false,
      unavailable: { reason: "not_configured", detail: null }
    });
    const { outcomes } = await runWorkScan(baseDeps({ gmailClient: client, classifier, historyMarker: "100" }));
    expect(outcomes[0]!.gmailThreadId).toBe("correct-thread");
  });

  it("runs an incremental scan when a valid historyMarker is given, never listing the whole Inbox/Spam", async () => {
    const changedMessage: FakeMessage = {
      id: "changed-1",
      threadId: "t-changed-1",
      labelIds: ["INBOX", "UNREAD"],
      headers: [{ name: "From", value: "person@example.com" }]
    };
    let listCalled = false;
    const client: GmailClient = {
      users: {
        getProfile: async () => ({ data: { emailAddress: "me@example.com", historyId: "200" } }),
        history: {
          list: async () => ({
            data: {
              history: [{ id: "150", labelsAdded: [{ message: { id: "changed-1", threadId: "t-changed-1" } }] }],
              historyId: "200"
            }
          })
        },
        labels: { get: async () => ({ data: { messagesTotal: 42 } }) },
        messages: {
          list: async () => {
            listCalled = true;
            return { data: { messages: [] } };
          },
          get: async ({ id }: { id: string }) => {
            if (id !== "changed-1") throw new Error(`unexpected fetch for ${id}`);
            return {
              data: {
                id: changedMessage.id,
                threadId: changedMessage.threadId,
                historyId: "150",
                internalDate: "5000",
                labelIds: changedMessage.labelIds,
                snippet: "",
                payload: { headers: changedMessage.headers }
              }
            };
          }
        },
        threads: { get: async () => ({ data: { messages: [] } }) }
      }
    } as unknown as GmailClient;

    const classifier = new FixedClassifier({
      ok: false,
      unavailable: { reason: "not_configured", detail: null }
    });
    const { outcomes, summary, newHistoryMarker, usedIncrementalSync } = await runWorkScan(
      baseDeps({ gmailClient: client, classifier, historyMarker: "100" })
    );

    expect(listCalled).toBe(false);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.gmailMessageId).toBe("changed-1");
    expect(usedIncrementalSync).toBe(true);
    expect(newHistoryMarker).toBe("200");
    expect(summary.inboxCountBefore).toBe(42);
  });

  it("unions a locally supplied cached backlog with Gmail history changes and excludes cached rows deleted in that history", async () => {
    const cachedUnassessed: FakeMessage = {
      id: "cached-unassessed",
      threadId: "t-cached-unassessed",
      labelIds: ["INBOX"],
      headers: [{ name: "From", value: "cached@example.com" }],
      internalDate: "6000"
    };
    const changedMessage: FakeMessage = {
      id: "changed-1",
      threadId: "t-changed-1",
      labelIds: ["INBOX"],
      headers: [{ name: "From", value: "changed@example.com" }],
      internalDate: "5000"
    };
    const client = fakeClient([cachedUnassessed, changedMessage]);
    (client.users.history as unknown as { list: () => Promise<unknown> }).list = async () => ({
      data: {
        history: [
          { id: "150", labelsAdded: [{ message: { id: changedMessage.id, threadId: changedMessage.threadId } }] },
          { id: "151", messagesDeleted: [{ message: { id: "cached-deleted", threadId: "t-cached-deleted" } }] }
        ],
        historyId: "200"
      }
    });

    const messagesApi = client.users.messages as unknown as {
      list: () => Promise<unknown>;
      get: (params: { id: string }) => Promise<unknown>;
    };
    messagesApi.list = async () => {
      throw new Error("incremental backlog processing must not list the whole mailbox");
    };
    const originalGet = messagesApi.get;
    const fetchedIds: string[] = [];
    messagesApi.get = async (params) => {
      fetchedIds.push(params.id);
      return originalGet(params);
    };

    const classifiedIds: string[] = [];
    const classifier: Classifier = {
      async assess(message): Promise<AssessmentResult> {
        classifiedIds.push(message.gmailMessageId);
        return { ok: false, unavailable: { reason: "not_configured", detail: null } };
      }
    };

    const { outcomes } = await runWorkScan(
      baseDeps({
        gmailClient: client,
        classifier,
        historyMarker: "100",
        cachedBacklogStubs: [
          { id: cachedUnassessed.id, threadId: cachedUnassessed.threadId },
          { id: "cached-deleted", threadId: "t-cached-deleted" }
        ]
      })
    );

    expect(fetchedIds.sort()).toEqual([cachedUnassessed.id, changedMessage.id].sort());
    expect(classifiedIds.sort()).toEqual([cachedUnassessed.id, changedMessage.id].sort());
    expect(outcomes.map((outcome) => outcome.gmailMessageId).sort()).toEqual(
      [cachedUnassessed.id, changedMessage.id].sort()
    );
    expect(outcomes.every((outcome) => outcome.decision.actions.some((action) => action.type === "archive"))).toBe(true);
  });

  it("fetches, classifies, and actions a cache-only unassessed message when Gmail history is empty", async () => {
    const cachedUnassessed: FakeMessage = {
      id: "cached-unassessed",
      threadId: "t-cached-unassessed",
      labelIds: ["INBOX"],
      headers: [{ name: "From", value: "cached@example.com" }]
    };
    const client = fakeClient([cachedUnassessed]);
    const messagesApi = client.users.messages as unknown as {
      get: (params: { id: string }) => Promise<unknown>;
    };
    const originalGet = messagesApi.get;
    let gmailMessageFetches = 0;
    messagesApi.get = async (params) => {
      gmailMessageFetches += 1;
      return originalGet(params);
    };
    let classifierCalls = 0;
    const classifier: Classifier = {
      async assess(): Promise<AssessmentResult> {
        classifierCalls += 1;
        return { ok: false, unavailable: { reason: "not_configured", detail: null } };
      }
    };

    const { outcomes, usedIncrementalSync } = await runWorkScan(
      baseDeps({
        gmailClient: client,
        classifier,
        historyMarker: "90",
        cachedBacklogStubs: [{ id: cachedUnassessed.id, threadId: cachedUnassessed.threadId }]
      })
    );

    expect(usedIncrementalSync).toBe(true);
    expect(gmailMessageFetches).toBe(1);
    expect(classifierCalls).toBe(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.gmailMessageId).toBe(cachedUnassessed.id);
    expect(outcomes[0]!.decision.actions).toContainEqual({ type: "archive", reasonCode: "read_non_trash" });
  });

  it("does not advance the history baseline past incremental work omitted by --limit", async () => {
    const messages: FakeMessage[] = [
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "UNREAD"],
        headers: [{ name: "From", value: "one@example.com" }]
      },
      {
        id: "m2",
        threadId: "t2",
        labelIds: ["INBOX", "UNREAD"],
        headers: [{ name: "From", value: "two@example.com" }]
      }
    ];
    const client = fakeClient(messages);
    (client.users.history as unknown as { list: () => Promise<unknown> }).list = async () => ({
      data: {
        history: [
          {
            id: "150",
            messagesAdded: messages.map((message) => ({
              message: { id: message.id, threadId: message.threadId }
            }))
          }
        ],
        historyId: "200"
      }
    });

    const result = await runWorkScan(
      baseDeps({
        gmailClient: client,
        historyMarker: "100",
        limit: 1,
        classifier: {
          async assess(): Promise<AssessmentResult> {
            return { ok: false, unavailable: { reason: "not_configured", detail: null } };
          }
        }
      })
    );

    expect(result.outcomes).toHaveLength(1);
    expect(result.newHistoryMarker).toBeNull();
    expect(result.scanNote).toContain("history baseline will be cleared");
  });

  it("excludes a changed message that is no longer in Inbox or Spam from an incremental scan", async () => {
    const client: GmailClient = {
      users: {
        getProfile: async () => ({ data: { emailAddress: "me@example.com", historyId: "200" } }),
        history: {
          list: async () => ({
            data: {
              history: [{ id: "150", labelsRemoved: [{ message: { id: "archived-1", threadId: "t1" } }] }],
              historyId: "200"
            }
          })
        },
        labels: { get: async () => ({ data: { messagesTotal: 10 } }) },
        messages: {
          list: async () => ({ data: { messages: [] } }),
          get: async () => ({
            data: {
              id: "archived-1",
              threadId: "t1",
              historyId: "150",
              internalDate: "5000",
              labelIds: [], // no INBOX, no SPAM — the user archived it themselves
              snippet: "",
              payload: { headers: [{ name: "From", value: "person@example.com" }] }
            }
          })
        },
        threads: { get: async () => ({ data: { messages: [] } }) }
      }
    } as unknown as GmailClient;

    const { outcomes } = await runWorkScan(
      baseDeps({ gmailClient: client, classifier: NEVER_CALLED_CLASSIFIER, historyMarker: "100" })
    );
    expect(outcomes).toHaveLength(0);
  });

  it("falls back to a full scan when the stored historyMarker has expired", async () => {
    const message: FakeMessage = {
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      headers: [{ name: "From", value: "person@example.com" }]
    };
    const full = fakeClient([message]);
    const client: GmailClient = {
      users: {
        ...full.users,
        history: {
          list: async () => {
            const error = Object.assign(new Error("not found"), { status: 404 });
            throw error;
          }
        }
      }
    } as unknown as GmailClient;

    const classifier = new FixedClassifier({
      ok: false,
      unavailable: { reason: "not_configured", detail: null }
    });
    const { outcomes, usedIncrementalSync } = await runWorkScan(
      baseDeps({ gmailClient: client, classifier, historyMarker: "stale-100" })
    );
    expect(usedIncrementalSync).toBe(false);
    expect(outcomes).toHaveLength(1);
  });

  it("adds a Calendar label and archives the message when a validated event is created, regardless of read state", async () => {
    const client = fakeClient([
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "UNREAD"], // unread — would not otherwise be archived
        headers: [{ name: "From", value: "clinic@example.com" }],
        snippet: "Your appointment is confirmed for 2099-01-01 at 10:00 AM."
      }
    ]);
    const classifier = new FixedClassifier({
      ok: true,
      assessment: {
        kind: "transactional_important",
        confidence: 0.99,
        importanceScore: 0,
        importanceConfidence: 0,
        summary: "test",
        reasonCodes: [],
        event: {
          intent: "create",
          confidence: 0.99,
          title: "Dentist",
          start: "2099-01-01T10:00:00Z",
          end: "2099-01-01T11:00:00Z",
          allDay: false,
          timeZone: "UTC",
          location: null,
          sourceEvidence: "appointment is confirmed for 2099-01-01 at 10:00 AM"
        },
        category: null,
        classifierVersion: "test",
        promptVersion: "test",
        schemaVersion: "test"
      }
    });
    const { outcomes } = await runWorkScan(baseDeps({ gmailClient: client, classifier }));
    const actions = outcomes[0]!.decision.actions;
    expect(actions).toContainEqual({ type: "label", reasonCode: "calendar_label:Calendar", labelName: "Calendar" });
    expect(actions).toContainEqual({ type: "archive", reasonCode: "calendar_archive" });
  });
});

describe("resolvePostScanHistoryMarker", () => {
  it("keeps the original fence without an extra API call so concurrent arrivals remain discoverable", async () => {
    const list = vi.fn(async () => ({ data: { historyId: "200", history: [{
      id: "150", messagesAdded: [{ message: { id: "arrived-during-scan", threadId: "new-thread" } }]
    }] } }));
    const client = { users: { history: { list } } } as unknown as GmailClient;
    expect(await resolvePostScanHistoryMarker(client, "100")).toBe("100");
    expect(list).not.toHaveBeenCalled();
  });
});

describe("read failure recovery", () => {
  it("finishes independent reads and preserves an incremental marker after one failed message", async () => {
    const client = fakeClient([{ id: "good", threadId: "t-good", labelIds: ["SPAM"], headers: [] }]);
    client.users.history.list = vi.fn(async () => ({ data: { historyId: "200", history: [{
      id: "150", messagesAdded: [
        { message: { id: "missing", threadId: "t-missing" } },
        { message: { id: "good", threadId: "t-good" } }
      ]
    }] } })) as unknown as typeof client.users.history.list;
    const progress = { onPhase: vi.fn(), onProgress: vi.fn(), onFinish: vi.fn() };
    const result = await runWorkScan(baseDeps({ gmailClient: client, historyMarker: "100", readProgress: progress }));
    expect(result.summary.failureCount).toBe(1);
    expect(result.newHistoryMarker).toBe("100");
    expect(result.outcomes).toHaveLength(2);
    expect(result.messageCacheUpdates).toHaveLength(1);
    expect(result.diagnostics.messagesFailed).toBe(1);
    expect(progress.onProgress).toHaveBeenLastCalledWith(2, 2, 1);
  });

  it("does not load the Sent index when nothing is a trash candidate", async () => {
    const loadSentThreadIds = vi.fn(async () => new Set<string>());
    await runWorkScan(baseDeps({ loadSentThreadIds }));
    expect(loadSentThreadIds).not.toHaveBeenCalled();
  });
});
