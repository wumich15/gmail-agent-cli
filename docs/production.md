# Running and deploying the hosted service

This describes how to stand up the two publisher-operated pieces — the setup
site in `hosting/` and the AI gateway in `gateway/` — and how to build a
release of the CLI that knows about them.

**None of this is currently in use, and none of it is needed to run the tool.**
A build from this repository embeds no publisher configuration, signs in with a
Google client you register yourself, and uses your own AI key or no AI at all.
Everything here exists so that the option remains open — if the tool is ever
distributed to other people, this is what that would take.

## What has to be decided before any of this is built

These are not engineering choices and the code cannot supply them. They are
recorded in [the launch decision record](launch/decisions.md); the short list:

1. The legal publisher, the permanent product name, the domain, and the
   privacy, security, and support contacts.
2. The model provider, which must pass a written data-handling gate before any
   Gmail content reaches it — see "Choosing a provider" below.
3. The processing region, the fair-use allowance, and the maximum monthly spend.
4. Whether Calendar stays in the launch scope.
5. Google's restricted-scope verification and the applicable security
   assessment, which are almost certainly the schedule-driving items.

## Choosing a provider

The gateway speaks the Responses API with Structured Outputs, so any provider
implementing that shape can back it. The technical fit is not the gate; the
data handling is.

Google's Workspace API user-data policy applies Limited Use rules to anything
derived from Gmail scopes, and prohibits using it to train or improve a
generalized model or for any unrelated secondary purpose. So before a single
real message is sent to a provider, obtain written terms covering retention,
human access, abuse-monitoring, training, region, and **any secondary use of
prompt content at all** — including anonymized sampling for categorization,
reporting, or model ranking.

This matters concretely for OpenRouter, which is otherwise a strong fit:
its published data-collection documentation says a small number of prompts are
sampled for anonymous categorization used in reporting and model ranking even
when ordinary logging and the input/output-use setting are off.
`GATEWAY_PROVIDER_ZDR` and `GATEWAY_PROVIDER_DENY_COLLECTION` (both default on)
send the zero-data-retention and deny-upstream-collection routing flags with
every request, and those govern the *upstream* model provider — they do not,
per that documentation, disable OpenRouter's own sampling. Treat OpenRouter as
blocked for Gmail content until that specific secondary use is contractually
and technically disabled for these requests. Evaluate a direct enterprise
provider — paid Vertex AI/Gemini under Google Cloud's service-specific terms is
the recommended first candidate — otherwise.

Whatever is chosen, the rule is the same: if no compliant route is available,
the request fails and the CLI falls back to rules only. There is no silent
downgrade to a weaker route.

## One-time Google setup

1. In the production Cloud project, enable the Gmail API and (if Calendar stays
   in scope) the Calendar API.
2. Configure the Google Auth Platform branding, audience, verified domain, home
   page, privacy policy, terms, and support URLs. They must point at the real
   deployed pages in `hosting/`, not at placeholders.
3. Create a **Desktop app** OAuth client. Its ID and secret are embedded in the
   release; an installed-app client secret is not confidential, which is why
   sign-in also uses PKCE `S256`, a random `state`, an OIDC nonce, and a
   loopback-only redirect.
4. Keep development, staging, and production OAuth clients separate.
5. Complete Google's restricted-scope verification and any required security
   assessment before broadening past a controlled test audience. Until then,
   External Testing is limited to listed test users and Gmail-scope grants
   expire after seven days.

## Firebase project

```sh
firebase login
firebase use --add                 # select the production project
pnpm --dir gateway install --ignore-workspace
```

The project must be on the Blaze plan: static Hosting is inexpensive, but a
server-side gateway requires billing. Enable Firebase Authentication (for the
custom-token session only — it is *not* the Gmail authorization mechanism) and
Firestore.

### Secrets

Two, both bound only to the function's runtime:

```sh
firebase functions:secrets:set GATEWAY_PROVIDER_API_KEY
firebase functions:secrets:set USER_ID_HMAC_KEY     # e.g. openssl rand -hex 32
```

`USER_ID_HMAC_KEY` is what makes stored records pseudonymous: it turns Google's
stable subject into an identifier that cannot be reversed without it. Rotating
it re-pseudonymizes everyone, which orphans existing consent receipts and
counters — treat it as permanent for the life of the deployment.

Neither secret may appear in Hosting assets, a committed `.env`, a build
argument, client configuration, or a response body.

### Runtime settings

Set the rest as ordinary environment configuration on the function:

| Variable | Meaning |
| --- | --- |
| `GATEWAY_GOOGLE_OAUTH_CLIENT_ID` | The publisher Desktop client. A Google ID token must carry exactly this audience. |
| `GATEWAY_POLICY_VERSION` | Must equal `HOSTED_AI_POLICY_VERSION` in `src/auth/publisher-client.ts`. A mismatch stops message text and forces re-consent. |
| `GATEWAY_PROVIDER_BASE_URL` | Responses-API base URL of the approved model service. |
| `GATEWAY_CLASSIFY_MODEL`, `GATEWAY_DRAFT_MODEL` | Pinned model snapshots. A moving alias is acceptable only in development. |
| `GATEWAY_QUOTA_PER_MINUTE`, `_PER_DAY`, `_PER_MONTH` | Per-user allowance. Defaults 60 / 500 / 5000. |
| `GATEWAY_BETA_ALLOW_LIST` | Comma-separated pseudonymous user IDs. Empty means generally available. |
| `GATEWAY_ALLOWANCE_DESCRIPTION` | One line echoed to the user after setup. |
| `GATEWAY_DISABLED` | `true` turns every AI operation off without a redeploy. The incident control. |

The service refuses to start if any required setting is missing, rather than
coming up and failing every request or authenticating nobody correctly.

### Beta access

`GATEWAY_BETA_ALLOW_LIST` holds pseudonymous user IDs, not email addresses —
the CLI does not request the `email` scope, so the service has no address to
match. A user who is not on the list is told their own pseudonymous ID and can
quote it to ask for access. That keeps the beta gate from requiring the service
to learn anyone's address.

## Deploy

```sh
node scripts/verify-hosting.mjs           # no placeholders, no third-party assets
pnpm --dir gateway run build
firebase deploy --only hosting,functions,firestore:rules,firestore:indexes
```

Deploy to a separate staging project first and exercise malformed tokens,
replay, a revoked user, an oversized body, unknown fields, an attempt to name a
model, rate limits, a provider failure, and the kill switch. A Hosting preview
channel (`firebase hosting:channel:deploy setup-preview`) reviews the static
pages but is not a substitute for a deployed staging gateway.

Connect the custom domain, wait for managed TLS, and use that domain in every
Google Auth Platform link.

## Building a release of the CLI

```sh
pnpm build
GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID=... \
GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET=... \
GMAIL_AGENT_PUBLISHER_SETUP_PAGE_URL=https://setup.example.com \
GMAIL_AGENT_PUBLISHER_AI_GATEWAY_URL=https://ai.example.com \
GMAIL_AGENT_PUBLISHER_FIREBASE_API_KEY=... \
  pnpm embed:release
pnpm verify:package
```

`embed:release` replaces the markers in `dist/auth/publisher-client.js`. The
source tree holds markers rather than values so a developer's own Cloud project
can never be published by accident, and so a self-built copy is honest about
having no publisher behind it.

`verify:package` then refuses a half-embedded build, a non-HTTPS or loopback
endpoint, a client ID that is not a Google one, and any model-provider key,
Google token, private key, saved OAuth client, `.env`, database, or log inside
the packed tarball.

## Local development against the emulators

```sh
pnpm --dir gateway run serve     # functions + firestore + hosting emulators

export GMAIL_AGENT_AI_GATEWAY_URL=http://127.0.0.1:5001/<project>/us-central1/api
export GMAIL_AGENT_FIREBASE_API_KEY=<web api key>
export GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_ID=<staging desktop client id>
export GMAIL_AGENT_PUBLISHER_OAUTH_CLIENT_SECRET=<staging desktop client secret>
export GMAIL_AGENT_SETUP_PAGE_URL=http://127.0.0.1:5000
pnpm dev setup
```

`http://127.0.0.1` is accepted for these two URLs precisely so this works;
`verify:package` is what keeps it from reaching a release.

Use synthetic or explicitly authorized mail fixtures only. Never point a
development gateway at a real mailbox belonging to someone else.
