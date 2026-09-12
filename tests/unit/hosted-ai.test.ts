import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostedOnboardingAvailable,
  normalizeServiceUrl,
  publisherOnboardingConfigured,
  resolveHostedAiService,
  resolvePublisherOAuthClient
} from "../../src/auth/publisher-client.js";
import {
  hostedSetupPageFor,
  resolveOAuthClientCredentials,
  verifyIdTokenShape
} from "../../src/auth/google-oauth.js";
import { writeStoredOAuthClient } from "../../src/auth/oauth-client-file.js";
import { HostedAiClient, HostedAiError } from "../../src/ai/hosted-client.js";
import { HostedClassifier } from "../../src/ai/hosted-classifier.js";
import { HOSTED_CONTRACT_VERSION, HostedClassifyRequestSchema } from "../../src/ai/hosted-contract.js";
import { sentMailStyleSamplingAllowed, defaultConfig, parseConfig } from "../../src/config/schema.js";
import type { HostedSession } from "../../src/auth/hosted-session.js";
import type { NormalizedMessage } from "../../src/core/models.js";

const PUBLISHER_ENV = {
  GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID: "publisher-123.apps.googleusercontent.com",
  GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET: "GOCSPX-publisher",
  GMAIL_AGENT_SETUP_PAGE_URL: "https://setup.example.test",
  GMAIL_AGENT_AI_GATEWAY_URL: "https://ai.example.test",
  GMAIL_AGENT_FIREBASE_API_KEY: "AIzaTestKeyValue"
} satisfies NodeJS.ProcessEnv;

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    gmailMessageId: "m1",
    threadId: "t1",
    historyId: "1",
    internalDate: "1757548800000",
    labelIds: ["INBOX"],
    snippet: "snippet text",
    subject: "Subject line",
    from: { displayName: "Alice", address: "alice@example.com" },
    replyTo: null,
    to: [],
    dateHeader: null,
    messageIdHeader: null,
    listId: null,
    listUnsubscribe: null,
    listUnsubscribePost: null,
    autoSubmitted: null,
    precedence: null,
    authenticationResults: null,
    dkimSignature: null,
    bodyText: "The actual body of the message.",
    bodyTruncated: false,
    hasCalendarPart: false,
    ...overrides
  } as NormalizedMessage;
}

function stubSession(): HostedSession {
  return { idToken: async () => "firebase-id-token" } as unknown as HostedSession;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publisher release configuration", () => {
  it("requires both halves of the hosted service before offering it", () => {
    // Half-configured is worse than absent: hosted mode would be selectable
    // and then fail on the first classify call, after the user had already
    // consented to it.
    expect(resolveHostedAiService({ GMAIL_AGENT_AI_GATEWAY_URL: "https://ai.example.test" })).toBeNull();
    expect(resolveHostedAiService({ GMAIL_AGENT_FIREBASE_API_KEY: "AIza" })).toBeNull();
    expect(resolveHostedAiService(PUBLISHER_ENV)).toMatchObject({
      baseUrl: "https://ai.example.test",
      source: "environment"
    });
  });

  it("resolves nothing in a source checkout, so the CLI can say so honestly", () => {
    expect(resolvePublisherOAuthClient({})).toBeNull();
    expect(resolveHostedAiService({})).toBeNull();
    expect(publisherOnboardingConfigured({})).toBe(false);
    expect(hostedOnboardingAvailable({})).toBe(false);
  });

  it("will not offer hosted AI from a build that could not finish connecting it", () => {
    // The session is minted from the ID token the publisher's own consent
    // produces, so a gateway with no publisher client or no disclosure page
    // would let a user accept a disclosure and then fall back to rules only on
    // every run.
    const without = (key: keyof typeof PUBLISHER_ENV): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = { ...PUBLISHER_ENV };
      delete env[key];
      return env;
    };
    expect(hostedOnboardingAvailable(without("GMAIL_AGENT_SETUP_PAGE_URL"))).toBe(false);
    expect(hostedOnboardingAvailable(without("GMAIL_AGENT_AI_GATEWAY_URL"))).toBe(false);
    expect(hostedOnboardingAvailable(without("GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID"))).toBe(false);
    expect(hostedOnboardingAvailable(PUBLISHER_ENV)).toBe(true);
  });

  it("refuses a service URL that is not HTTPS, carries credentials, or hides a query string", () => {
    expect(() => normalizeServiceUrl("http://ai.example.test", "AI gateway")).toThrow(/HTTPS/);
    expect(() => normalizeServiceUrl("https://user:pass@ai.example.test", "AI gateway")).toThrow(/credentials/);
    // Loopback stays reachable so the gateway can be run locally; the release
    // gate in scripts/verify-package.mjs is what keeps that out of a package.
    expect(normalizeServiceUrl("http://127.0.0.1:5001", "AI gateway")).toBe("http://127.0.0.1:5001");
    expect(normalizeServiceUrl("https://ai.example.test/?token=abc#frag", "AI gateway")).toBe(
      "https://ai.example.test"
    );
  });
});

describe("OAuth client precedence", () => {
  it("keeps a client the user registered themselves ahead of the publisher's", () => {
    // Someone who went to the trouble of registering their own Cloud project
    // has an advanced configuration that a package upgrade must not silently
    // take over; their mail would start flowing through another OAuth project
    // and quota without them choosing that.
    const dataDir = mkdtempSync(join(tmpdir(), "gmail-agent-oauth-"));
    const env = { ...PUBLISHER_ENV, GMAIL_AGENT_DATA_DIR: dataDir } satisfies NodeJS.ProcessEnv;
    expect(resolveOAuthClientCredentials(env).source).toBe("publisher");

    writeStoredOAuthClient({ clientId: "mine-456.apps.googleusercontent.com", clientSecret: "GOCSPX-mine" }, env);
    expect(resolveOAuthClientCredentials(env)).toMatchObject({
      clientId: "mine-456.apps.googleusercontent.com",
      source: "stored"
    });

    expect(
      resolveOAuthClientCredentials({
        ...env,
        GMAIL_AGENT_OAUTH_CLIENT_ID: "env-789.apps.googleusercontent.com",
        GMAIL_AGENT_OAUTH_CLIENT_SECRET: "GOCSPX-env"
      }).source
    ).toBe("environment");
  });

  it("only routes a publisher sign-in through the hosted disclosure page", () => {
    // The page discloses what the publisher's service does with mail. Somebody
    // signing in through their own Cloud project is not using that service, so
    // showing it would describe a transfer that is not going to happen.
    expect(hostedSetupPageFor({ clientId: "x", clientSecret: "y", source: "publisher" }, PUBLISHER_ENV)).toBe(
      "https://setup.example.test"
    );
    expect(hostedSetupPageFor({ clientId: "x", clientSecret: "y", source: "stored" }, PUBLISHER_ENV)).toBeNull();
    expect(hostedSetupPageFor({ clientId: "x", clientSecret: "y", source: "environment" }, PUBLISHER_ENV)).toBeNull();
  });
});

describe("Google ID token checks the CLI can make itself", () => {
  const token = (claims: Record<string, unknown>): string =>
    [
      Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      "signature"
    ].join(".");

  it("accepts a token matching this sign-in's nonce, audience, and issuer", () => {
    expect(() =>
      verifyIdTokenShape(token({ nonce: "n1", aud: "client-1", iss: "https://accounts.google.com" }), {
        nonce: "n1",
        audience: "client-1"
      })
    ).not.toThrow();
  });

  it("rejects a replayed nonce, a token minted for another app, or a foreign issuer", () => {
    const expected = { nonce: "n1", audience: "client-1" };
    expect(() =>
      verifyIdTokenShape(token({ nonce: "other", aud: "client-1", iss: "accounts.google.com" }), expected)
    ).toThrow(/nonce/);
    expect(() =>
      verifyIdTokenShape(token({ nonce: "n1", aud: "someone-else", iss: "accounts.google.com" }), expected)
    ).toThrow(/different app/);
    expect(() =>
      verifyIdTokenShape(token({ nonce: "n1", aud: "client-1", iss: "https://evil.example" }), expected)
    ).toThrow(/not issued by Google/);
    expect(() => verifyIdTokenShape("not-a-jwt", expected)).toThrow(/malformed/i);
  });
});

describe("hosted gateway client", () => {
  const service = { baseUrl: "https://ai.example.test", firebaseApiKey: "AIza", source: "environment" as const };

  function respondWith(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
    ) as unknown as typeof fetch;
  }

  it("sends the contract version and a bearer token, and nothing that names a model", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, flags: flags(), modelVersion: "pinned-model" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new HostedAiClient(service, stubSession());
    await client.classify({ message: wireMessage(), existingLabels: [] });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ai.example.test/v1/ai/classify");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer firebase-id-token");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["contractVersion"]).toBe(HOSTED_CONTRACT_VERSION);
    // The whole point of the narrow contract: nothing a caller sends can
    // choose a model, a provider, a tool, or an endpoint.
    expect(Object.keys(body).sort()).toEqual(["contractVersion", "existingLabels", "message"]);
  });

  it("classifies each failure so the caller knows whether retrying could ever help", async () => {
    const cases = [
      { status: 401, kind: "auth" },
      { status: 403, kind: "auth" },
      { status: 429, kind: "quota" },
      { status: 409, kind: "contract" },
      { status: 400, kind: "contract" }
    ] as const;
    for (const { status, kind } of cases) {
      vi.stubGlobal("fetch", respondWith(status, { error: "nope" }));
      const client = new HostedAiClient(service, stubSession());
      await expect(client.classify({ message: wireMessage(), existingLabels: [] })).rejects.toMatchObject({ kind });
    }
  });

  it("retries only a transient failure, and reports how long to wait when told", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "busy" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HostedAiClient(service, stubSession());
    await expect(client.classify({ message: wireMessage(), existingLabels: [] })).rejects.toBeInstanceOf(
      HostedAiError
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // An authorization failure cannot resolve itself, so it is never retried.
    const rejecting = vi.fn(async () => new Response(JSON.stringify({ error: "no" }), { status: 401 }));
    vi.stubGlobal("fetch", rejecting);
    await expect(
      new HostedAiClient(service, stubSession()).classify({ message: wireMessage(), existingLabels: [] })
    ).rejects.toMatchObject({ kind: "auth" });
    expect(rejecting).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", respondWith(429, { error: "allowance" }, { "retry-after": "120" }));
    await expect(
      new HostedAiClient(service, stubSession()).classify({ message: wireMessage(), existingLabels: [] })
    ).rejects.toMatchObject({ kind: "quota", retryAfterSeconds: 120 });
  });

  it("treats an unparseable response as a contract problem rather than a model one", async () => {
    vi.stubGlobal("fetch", respondWith(200, { ok: true, somethingElse: 1 }));
    await expect(
      new HostedAiClient(service, stubSession()).classify({ message: wireMessage(), existingLabels: [] })
    ).rejects.toMatchObject({ kind: "contract" });
  });
});

describe("hosted classifier", () => {
  const service = { baseUrl: "https://ai.example.test", firebaseApiKey: "AIza", source: "environment" as const };

  it("maps the gateway's flags onto the same internal assessment a local run produces", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, flags: { ...flags(), tag: "spam" }, modelVersion: "pinned" }), {
          status: 200
        })
      )
    );
    const classifier = new HostedClassifier(new HostedAiClient(service, stubSession()), "hosted:v1");
    const result = await classifier.assess(message(), context());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.kind).toBe("promotion");
      expect(result.assessment.classifierVersion).toBe("hosted:v1");
    }
  });

  it("stops calling after a terminal failure instead of repeating it once per message", async () => {
    // A mailbox with a thousand unresolved messages must not produce a
    // thousand identical 429s once the allowance is known to be gone.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "allowance" }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const classifier = new HostedClassifier(new HostedAiClient(service, stubSession()), "hosted:v1");

    const first = await classifier.assess(message(), context());
    const second = await classifier.assess(message(), context());
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(classifier.stoppedBecause()).toMatch(/allowance/i);
  });

  it("never turns a failure into a mutation-worthy assessment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, reason: "refused", detail: "declined" }), { status: 200 })
      )
    );
    const classifier = new HostedClassifier(new HostedAiClient(service, stubSession()), "hosted:v1");
    const result = await classifier.assess(message(), context());
    expect(result).toEqual({ ok: false, unavailable: { reason: "refused", detail: "declined" } });
  });
});

describe("hosted wire contract", () => {
  it("rejects an unknown field rather than ignoring it", () => {
    const valid = { contractVersion: HOSTED_CONTRACT_VERSION, message: wireMessage(), existingLabels: [] };
    expect(HostedClassifyRequestSchema.safeParse(valid).success).toBe(true);
    expect(HostedClassifyRequestSchema.safeParse({ ...valid, model: "gpt-whatever" }).success).toBe(false);
    expect(HostedClassifyRequestSchema.safeParse({ ...valid, tools: [] }).success).toBe(false);
  });

  it("rejects oversized input so a modified client cannot buy a giant prompt", () => {
    const oversized = {
      contractVersion: HOSTED_CONTRACT_VERSION,
      message: { ...wireMessage(), content: "x".repeat(100_000) },
      existingLabels: []
    };
    expect(HostedClassifyRequestSchema.safeParse(oversized).success).toBe(false);
    expect(
      HostedClassifyRequestSchema.safeParse({
        contractVersion: HOSTED_CONTRACT_VERSION,
        message: wireMessage(),
        existingLabels: Array.from({ length: 5_000 }, (_, index) => `label-${index}`)
      }).success
    ).toBe(false);
  });

  it("rejects a contract version this build does not speak", () => {
    expect(
      HostedClassifyRequestSchema.safeParse({ contractVersion: 99, message: wireMessage(), existingLabels: [] })
        .success
    ).toBe(false);
  });
});

describe("Sent-mail style sampling", () => {
  it("is off under hosted AI and on under the user's own provider", () => {
    // Style sampling reads a dozen unrelated Sent messages the user did not
    // select for this draft. The hosted disclosure deliberately does not claim
    // it, so the hosted provider must not do it.
    const hosted = parseConfig({
      ...defaultConfig("UTC"),
      aiEnabled: true,
      aiProvider: "hosted",
      hostedAiConsent: { policyVersion: "v", acceptedAt: "2026-01-01T00:00:00.000Z" }
    });
    expect(sentMailStyleSamplingAllowed(hosted)).toBe(false);
    expect(sentMailStyleSamplingAllowed(defaultConfig("UTC"))).toBe(true);
    expect(sentMailStyleSamplingAllowed(null)).toBe(true);
  });
});

function flags() {
  return {
    tag: "routine" as const,
    eventTitle: null,
    eventStart: null,
    eventEnd: null,
    eventAllDay: false,
    eventSourceEvidence: null,
    category: null
  };
}

function wireMessage() {
  return {
    fromDisplayName: "Alice",
    fromAddress: "alice@example.com",
    subject: "Subject line",
    sentDate: "2026-09-11",
    userTimeZone: "UTC",
    bulkSignal: false,
    content: "The actual body of the message.",
    contentIsFullBody: true,
    truncated: false
  };
}

function context() {
  return {
    classifierVersion: "hosted:v1",
    promptVersion: "prompt-v6",
    schemaVersion: "schema-v5",
    policyVersion: "policy-v1",
    existingLabels: [],
    userTimeZone: "UTC"
  };
}
