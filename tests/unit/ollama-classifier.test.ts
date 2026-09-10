import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaClassifier } from "../../src/ai/ollama-classifier.js";
import { buildNormalizedMessage, headerMapFromList } from "../../src/gmail/normalize.js";

const CONTEXT = { classifierVersion: "x", promptVersion: "x", schemaVersion: "x", policyVersion: "x" };

function message() {
  return buildNormalizedMessage({
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    historyId: "1",
    internalDate: "1000",
    labelIds: [],
    snippet: "Your package shipped",
    headers: headerMapFromList([
      { name: "From", value: "shop@example.com" },
      { name: "Subject", value: "Shipped" }
    ]),
    htmlBody: null,
    plainBody: null,
    userEmail: "me@example.com",
    threadHasUserSentMessage: false
  });
}

function respondWith(payload: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
  );
}

const flags = {
  tag: "routine",
  eventTitle: null,
  eventStart: null,
  eventEnd: null,
  eventAllDay: false,
  eventSourceEvidence: null,
  category: "Shopping"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaClassifier", () => {
  it("classifies through the local runtime with no API key and tags the version by provider", async () => {
    vi.stubGlobal("fetch", respondWith({ message: { content: JSON.stringify(flags) } }));
    const result = await new OllamaClassifier({ baseUrl: "http://127.0.0.1:11434", model: "llama3.2" }).assess(
      message(),
      CONTEXT
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assessment.classifierVersion).toBe("ollama:llama3.2");
    expect(result.assessment.category).toBe("Shopping");
  });

  it("constrains generation with the JSON schema, keeps mail out of the system message, and never streams", async () => {
    const fetchMock = respondWith({ message: { content: JSON.stringify(flags) } });
    vi.stubGlobal("fetch", fetchMock);
    await new OllamaClassifier({ baseUrl: "http://127.0.0.1:11434", model: "llama3.2" }).assess(message(), {
      ...CONTEXT,
      existingLabels: ["Receipts"]
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(String(init.body)) as {
      stream: boolean;
      format: { required: string[] };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.stream).toBe(false);
    expect(body.format.required).toContain("eventSourceEvidence");
    expect(body.messages[0]!.role).toBe("system");
    // The untrusted message may only ever appear in a user turn.
    expect(body.messages[0]!.content).not.toContain("Shipped");
    expect(body.messages[body.messages.length - 1]!.role).toBe("user");
    expect(body.messages[body.messages.length - 1]!.content).toContain("Shipped");
  });

  it("routes output that does not match the schema to review instead of trusting it", async () => {
    vi.stubGlobal("fetch", respondWith({ message: { content: JSON.stringify({ tag: "not-a-real-tag" }) } }));
    const result = await new OllamaClassifier({ baseUrl: "http://127.0.0.1:11434", model: "llama3.2" }).assess(
      message(),
      CONTEXT
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unavailable.reason).toBe("schema_failure");
  });

  it("reports a missing model as a setup problem rather than a provider outage", async () => {
    vi.stubGlobal("fetch", respondWith({ error: "model not found" }, 404));
    const result = await new OllamaClassifier({ baseUrl: "http://127.0.0.1:11434", model: "llama3.2" }).assess(
      message(),
      CONTEXT
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unavailable.reason).toBe("not_configured");
    expect(result.unavailable.detail).toContain("ollama pull llama3.2");
  });

  it("reports an unreachable runtime without throwing, so the run degrades to rules only", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await new OllamaClassifier({ baseUrl: "http://127.0.0.1:11434", model: "llama3.2" }).assess(
      message(),
      CONTEXT
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unavailable.reason).toBe("not_configured");
  });
});
