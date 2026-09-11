# Production release

The consumer flow is intentionally short: install the publisher build, run `gmail ui`, press **Connect Gmail**, and choose **Included GPT** if desired. Users do not create a Cloud project, download credentials, supply an OpenAI API key, or install a local model runtime. Classification, reply drafting, new-message drafting, and writing-style generation all use the publisher gateway.

Two publisher-owned services make that possible. They cannot be created or verified by source code alone:

1. A production Google Cloud project with Gmail and Calendar enabled, an external consent screen, verified publisher domains, and a Desktop OAuth client.
2. An HTTPS deployment of `gmail-ai-gateway` with the publisher's OpenAI API key. Google ID tokens authenticate users; the gateway never receives a Gmail access token or refresh token.

## Google launch gate

Configure the consent screen for `openid`, `email`, `https://www.googleapis.com/auth/gmail.modify`, and `https://www.googleapis.com/auth/calendar.events.owned`. The last two must match the capabilities represented in the product and privacy policy.

`gmail.modify` is a restricted scope. Public distribution requires Google's OAuth verification. Because Included GPT transmits selected restricted Gmail text through a publisher server to OpenAI, plan for the applicable third-party security assessment as well. Use separate Google projects and clients for development and production.

## Deploy the managed AI gateway

Build the project and run the dedicated gateway process behind an HTTPS reverse proxy or managed HTTPS service:

```sh
pnpm build
OPENAI_API_KEY="..." \
GMAIL_AGENT_GATEWAY_GOOGLE_CLIENT_ID="...apps.googleusercontent.com" \
GMAIL_AGENT_GATEWAY_SUBJECT_HMAC_KEY="at-least-32-random-characters" \
GMAIL_AGENT_GATEWAY_DB="/private/data/ai-gateway.sqlite" \
HOST="0.0.0.0" PORT="8787" \
node dist/gateway/cli.js
```

The gateway exposes `GET /health` and authenticated `POST /v1/responses`. It accepts only text-only Responses requests used by this app, forces `store: false`, caps output, rejects unapproved models/tools/extra fields, authenticates the Google ID token against the production Desktop client ID, hashes Google's stable subject before persistence, and enforces persistent per-minute and per-day request quotas.

The defaults allow `gpt-5.4-mini` and `gpt-5.6-luna`, 120 requests per minute, and 2,500 per day per Google account. Override these with `GMAIL_AGENT_GATEWAY_ALLOWED_MODELS`, `GMAIL_AGENT_GATEWAY_REQUESTS_PER_MINUTE`, and `GMAIL_AGENT_GATEWAY_REQUESTS_PER_DAY`. Put the database on durable private storage, back it up, rotate the OpenAI key and HMAC key through the hosting platform's secret manager, restrict network access to the database, and add infrastructure-level DDoS controls and monitoring before launch.

Generate the HMAC key with `pnpm gateway:secret` — never the example value above. That key is what keeps the stored quota identifiers pseudonymous, so anyone holding it can re-derive which hash belongs to a known Google account.

Run exactly one instance while the quota store is SQLite. Two instances on separate files silently double every user's quota; horizontal scaling requires a shared transactional store or a distributed rate limiter first.

### Operating the gateway

| Setting | Purpose |
| --- | --- |
| `GMAIL_AGENT_GATEWAY_ALLOWED_ACCOUNTS` | Beta audience: comma-separated `person@example.com` or `@example.com` entries. Empty means every signed-in Google account. The address is compared only — it is never stored, logged, or sent to OpenAI. |
| `GMAIL_AGENT_GATEWAY_BLOCKED_ACCOUNTS` | Always wins over the allowlist, so one abusive account can be cut off with a restart. |
| `GMAIL_AGENT_GATEWAY_METRICS_TOKEN` | When set, `GET /metrics` requires this bearer token. |
| `GMAIL_AGENT_GATEWAY_REQUEST_TIMEOUT_MS`, `GMAIL_AGENT_GATEWAY_MAX_CONNECTIONS` | Transport limits, in addition to the ones the reverse proxy enforces. |
| `GMAIL_AGENT_GATEWAY_SHUTDOWN_GRACE_MS` | How long SIGTERM lets in-flight OpenAI calls finish before connections are cut, so nobody is billed for a completion they never receive. |

A restricted deployment fails closed: without a verified email claim there is nothing to match an allowlist against, so the request is refused rather than guessed at.

`GET /health` returns `{"ok":true}` (503 while draining). `GET /metrics` returns Prometheus text: request counts by route and status, outcome classes, upstream failures, request-duration summary, in-flight gauge, and uptime — these are the availability, latency, error-rate, and quota-rejection dashboards the launch gate requires. One JSON line per request goes to stdout with a request ID, route, status, outcome, duration, model name, and a 12-character prefix of the pseudonymous subject hash. No Authorization header, ID token, message text, prompt, model response, email address, or OpenAI key is ever written to either surface.

Runbooks for deploy, rollback, restore, key rotation, OAuth-client replacement, and emergency disablement are in [operations/runbooks.md](operations/runbooks.md); the incident plan is in [operations/incident-response.md](operations/incident-response.md).

## Build the consumer artifact

Use distinct `GMAIL_AGENT_PUBLISHER_*` settings so the release cannot accidentally capture a developer override:

```sh
GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID="...apps.googleusercontent.com" \
GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET="..." \
GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL="https://ai.example.com" \
pnpm build:release
```

The build validates the Google client-ID shape and HTTPS gateway URL, compiles the app, and replaces release markers only in `dist/auth/publisher-client.js`. The Desktop client secret is not a security boundary; it is distributed with every native app. PKCE, random OAuth state, Google's consent screen, loopback-only callback, and server-side ID-token verification are the security controls.

Then verify the artifact before signing or publishing:

```sh
pnpm verify:release   # configured with publisher values, and free of credentials or development state
pnpm sbom             # CycloneDX bill of materials plus build provenance
```

`pnpm verify:release` fails if any release marker survived, if the embedded client ID or gateway URL is missing or malformed, or if the packed tarball contains an OpenAI key, Google token, private key, `.env`, local database, diagnostic log, or `node_modules`. It describes the embedded values by shape and length only, so it is safe to run in a shared CI log. `prepublishOnly` runs the release build **and** this verification, so publishing without all three publisher settings fails closed.

CI does this automatically: `.github/workflows/ci.yml` runs lint, type checking, tests, and a build on macOS, Linux, and Windows plus audit, license, SBOM, and secret scanning; `.github/workflows/release.yml` is the only job that reads the publisher secrets, and it verifies, attests, and checksums before anything can be published; `.github/workflows/gateway-staging.yml` runs synthetic contract tests against a staging gateway. After building, test the exact artifact on a clean OS account: Connect Gmail without development variables, select Included GPT without an OpenAI key, preview a small mailbox sample, draft (but do not send) a reply, disconnect, and confirm the Google grant is revoked.

For direct GPT development testing, continue to use `OPENAI_API_KEY` with the **Your own OpenAI API key** option. `pnpm test:gpt` runs a classifier call and a drafting call using synthetic content only. That path bypasses the gateway and exercises the same GPT adapters without requiring Gmail access.
