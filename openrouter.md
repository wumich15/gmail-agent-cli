# OpenRouter direction: one-sign-in Gmail CLI plan

Prepared September 12, 2026. This is a planning document only. It does not claim that the hosted setup page, shared Google OAuth client, AI gateway, or OpenRouter integration already exists. For future product direction, it supersedes the user-supplied-AI-key onboarding described in earlier plans; it does not alter the current implementation by itself.

## Executive decision

The normal user experience should be:

1. Install Gmail Agent and run `gmail setup`.
2. A small hosted page opens in the system browser.
3. Read one clear Gmail/AI data disclosure and continue with Google.
4. Google returns authorization directly to a one-time listener in the terminal app.
5. Return to the terminal and use `gmail` immediately.

The user should not create a Google Cloud project, download an OAuth credentials file, open an OpenRouter account, or paste an AI API key.

The recommended implementation is a publisher-owned Google Desktop OAuth client plus a narrow, authenticated AI gateway on Firebase/Google Cloud. The gateway exposes only Gmail Agent operations such as classification and drafting. It must never expose a generic OpenAI-compatible proxy or return a provider key to the CLI.

OpenRouter is a strong technical fit, but it is **not approved as the default provider under its currently published standard data behavior**. OpenRouter says it samples a small number of prompts for anonymous categorization used in reporting and model ranking even when ordinary prompt logging and input/output-use opt-ins are off. Google's Limited Use rules apply to data derived from Gmail scopes and prohibit unrelated AI/model improvement. Before any Gmail content goes through OpenRouter, obtain written/contractual confirmation and an enforceable control that disables this secondary use. If that is unavailable, use Vertex AI/Gemini or another direct enterprise provider whose final terms and controls satisfy Limited Use. [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection) [Google Workspace API user-data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)

OpenRouter OAuth can technically create a user-controlled API key through PKCE without manual copying. It does **not** meet the primary requirement because the user still needs an OpenRouter account and credits, it adds a second authorization after Google, and a user-owned OpenRouter workspace may have logging or input/output-use settings that this app cannot reliably enforce. Do not ship it for Gmail content unless the same Limited Use gate can be enforced per request or contractually for those users.

There is no static-only trick that eliminates both credentials and billing. Paid inference must be charged either to the publisher through an authenticated service or to the user's provider account through provider OAuth. For the promised one-Google-sign-in experience, the publisher must fund and operate the AI service.

## Goals and non-goals

### Required outcome

- One browser-based Google consent flow initiated by `gmail setup`.
- No user-managed Google OAuth configuration.
- No user-managed AI key or required AI-provider account.
- Gmail access and refresh tokens remain on the user's computer in the OS credential store.
- The hosted service receives only a short-lived identity token and the minimum email text required for the requested AI operation.
- Setup itself does not read, classify, modify, draft, or send mail.
- After setup, the CLI recommends a bounded dry run before any mutation.
- Rules-only operation remains available to users who decline hosted AI or when the AI service is unavailable.

### Not part of this direction

- A webmail replacement or hosted inbox.
- Storing Gmail refresh tokens in Firebase.
- A browser-only Gmail authorization flow that leaves the terminal disconnected.
- Embedding any publisher model-provider key in the package.
- Giving each public CLI installation an unrestricted publisher-funded bearer key.
- A general-purpose `/chat/completions` or `/responses` relay.
- Silent fallback to a different model/provider with weaker privacy settings.
- Unlimited free usage.

## Why the flow must begin in the terminal

Google recommends the Desktop/Installed App authorization-code flow for command-line applications: use the system browser, PKCE with `S256`, a random `state`, and a loopback callback on a random local port. The secure v1 flow therefore starts with one command so the CLI can open a temporary listener before the browser redirect returns. [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)

A genuinely website-first flow—visit a page, sign in, and install the CLI afterward—would need a pairing broker and temporary server-side custody of authorization results. That adds account-linking, token-handling, expiry, replay, and privacy risk without improving the normal installed-user flow. Do not build that for v1.

Google's device flow is not an alternative because its permitted scopes do not include Gmail, and the old copy/paste out-of-band flow is no longer supported. [Google OAuth for limited-input devices](https://developers.google.com/identity/protocols/oauth2/limited-input-device)

## Recommended architecture

```text
User runs `gmail setup`
        |
        | starts 127.0.0.1 listener; creates state + PKCE
        v
Firebase Hosting setup/disclosure page
        |
        | user chooses hosted AI or rules-only, then continues
        v
Google OAuth consent (publisher Desktop client)
        |
        | authorization code returns directly to 127.0.0.1
        v
CLI exchanges code locally and stores Google refresh token in OS keychain
        |
        | Gmail API calls stay CLI -> Google
        |
        | AI calls send a short-lived Firebase identity token + bounded text
        v
Authenticated Firebase Function v2 / Cloud Run gateway
        |
        | server credential, fixed operation schema, quotas, privacy controls
        v
Approved enterprise model API
(OpenRouter only after the Limited Use gate passes)
```

The setup page is a disclosure and launch surface. It does not receive the Google authorization code or any long-lived token. Gmail API traffic continues to go directly from the CLI to Google; it is not proxied through Firebase.

### Component responsibilities

| Component | Responsibility | Must not do |
| --- | --- | --- |
| CLI | Start loopback OAuth, exchange the code, keep Google credentials, call Gmail, request narrow AI operations, enforce local action policy and confirmations. | Send Gmail refresh/access tokens, attachments, or arbitrary model requests to the gateway. |
| Firebase Hosting | Show install/setup state, permission and AI disclosures, privacy/terms/support links, and success/error guidance. | Store tokens, use Firebase Web Google sign-in for durable Gmail access, run analytics, or accept arbitrary redirect URLs. |
| AI gateway | Authenticate the user, require a current hosted-AI consent receipt, validate a versioned operation schema, reserve quota, build server-owned prompts, call the approved model service, validate output, and record content-free usage metadata. | Act as a generic proxy, call Gmail, log message text, or return provider credentials. |
| Model service | Process an approved request under contractually verified Limited Use-compatible controls. OpenRouter is one candidate, not an assumption. | Use Gmail data for unrelated categorization, reporting/model ranking, generalized training, or another undisclosed secondary purpose. |
| Firestore | Hold pseudonymous consent/entitlement records, quota, and usage counters only. | Hold OAuth tokens, prompts, message content, model responses, or attachments. |
| Secret Manager | Hold any publisher provider key and the pseudonymization secret. Vertex AI can instead use the runtime service account. | Make secrets available to Hosting or the desktop bundle. |

## Detailed one-consent authentication flow

1. `gmail setup` binds a one-shot HTTP listener to `127.0.0.1` on a random available port. Prefer an IPv4 literal instead of `localhost` and close the listener after success, failure, or a short timeout.
2. The CLI generates two separate high-entropy values: a bootstrap state for the hosted page-to-loopback handoff and an OAuth state for Google. It also generates an OIDC nonce plus a PKCE verifier and `S256` challenge. The verifier never leaves the CLI.
3. The CLI opens a URL such as `https://setup.example.com/connect#port=49152&state=<bootstrap-state>`. The fragment is not sent in the Firebase Hosting request. It contains no token, authorization code, PKCE verifier, email address, or arbitrary callback URL.
4. The page validates the port and state format, displays the disclosure, and offers:
   - **Connect Gmail with hosted AI**
   - **Connect Gmail without hosted AI**
5. The selected button navigates to a fixed loopback path such as `http://127.0.0.1:<port>/begin`. It passes the bootstrap state and the selected local mode. The CLI validates and consumes the state, records the choice locally, and responds with a redirect to Google's authorization endpoint.
6. The Google request uses the publisher's distributed Desktop OAuth client ID, the CLI's loopback callback, the OAuth state, OIDC nonce, PKCE challenge, `access_type=offline`, and only the approved scopes. Do not force `prompt=consent` on every login; use it only to recover a genuinely missing refresh token.
7. Google redirects the authorization code to the CLI. The CLI validates the exact callback path and OAuth state, rejects replays, exchanges the code locally with the PKCE verifier, verifies the initial ID-token nonce and audience plus the granted scopes/account, and stores the Google refresh token only in the OS credential store.
8. If hosted AI was accepted, the CLI sends the initial Google ID token, the exact hosted-AI policy version, and the affirmative choice to `/v1/session/bootstrap`. The gateway verifies the Google token, stores a pseudonymous consent/entitlement receipt, and returns a short-lived Firebase custom token. The CLI exchanges it through Firebase Auth for Firebase ID and refresh tokens and stores the **separate** Firebase refresh token in the OS credential store. Rules-only setup skips this step.
9. The local callback can display a tiny success page or redirect to `https://setup.example.com/success`. No code or token is placed in that redirect.
10. The terminal prints the connected account, the selected AI mode, a disconnect command, and a safe first command such as `gmail --dry-run --limit 25`. It does not start processing mail automatically.

### Gateway authentication

Request `openid` with the Gmail scopes so Google returns an ID token as part of the same consent. Use it once to establish a durable, separately revocable Firebase session:

- The CLI verifies the OIDC nonce. `/v1/session/bootstrap` independently verifies Google's signature, issuer, expiry, and exact publisher Desktop client audience.
- It derives a non-reversible Firebase UID from Google's stable `sub`, records the accepted policy version/timestamp and active entitlement, and creates a short-lived Firebase custom token.
- The CLI exchanges that custom token through Firebase Auth for a Firebase ID token and Firebase refresh token. Both the Google and Firebase refresh tokens stay in the OS credential store, with distinct names and purposes.
- Every AI request carries a short-lived Firebase ID token. The gateway verifies it and requires a non-revoked entitlement with the current policy version before accepting message text.
- Choosing rules-only creates no hosted-AI entitlement. Enabling hosted AI later must reopen the immediately preceding disclosure and record a new receipt. A materially changed data policy must require re-consent.

This preserves one Google browser consent while avoiding dependence on a refreshed Google ID token always being returned by a particular OAuth library. [Firebase custom tokens](https://firebase.google.com/docs/auth/admin/create-custom-tokens) [Firebase Auth REST API](https://firebase.google.com/docs/reference/rest/auth) [Verify Firebase ID tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens)

Do not use a Firebase Web `signInWithPopup` flow as the Gmail authorization mechanism. Its Firebase refresh token refreshes Firebase identity, not durable Gmail access; the terminal still needs Google's offline authorization-code grant. [Firebase Google sign-in](https://firebase.google.com/docs/auth/web/google-signin)

### Scope decision

The smallest likely set for the current full product is:

- `openid`
- `email` only if the product needs to show or allowlist the address; the gateway should identify users by `sub`
- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/calendar.events.owned` only if a feature genuinely needs permission to see, create, change, and delete events on calendars the user owns

`gmail.modify` is a restricted scope. Avoid `https://mail.google.com/`, and do not request Calendar merely for possible future functionality. `calendar.events.owned` is broader than “events the app owns”: it authorizes event access on all calendars the user owns. Before implementation, decide whether Calendar is essential to the first hosted release. If it is deferred, make calendar-like mail fail conservatively rather than broadening Gmail actions. [Gmail OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) [Calendar OAuth scopes](https://developers.google.com/workspace/calendar/api/auth)

## AI funding and provider decision

### Recommended default: publisher-funded gateway, provider chosen by the Limited Use gate

This is the only architecture that provides one Google consent and no user AI account:

- The publisher pays for model usage.
- Any provider inference key lives in Secret Manager and is bound only to the gateway runtime; Vertex AI can use the runtime's service account instead.
- The CLI authenticates every request with the Firebase identity described above.
- The gateway exposes narrow operations, requires a current consent receipt, applies per-user and global limits, and sends only approved requests to the selected model service.
- Start with an allowlisted beta and a small, visible fair-use allowance. Google OAuth proves an account identity; it does not prevent one person from creating multiple accounts or modifying an open-source client.

Use OpenRouter only if it supplies an account/workspace or enterprise control, backed by written terms, that disables its anonymous prompt categorization and every other secondary content use. Provider-side ZDR and `data_collection: "deny"` govern upstream model-provider handling; they do not, according to the public documentation, disable OpenRouter's own sampling. If this gate fails, prefer paid Vertex AI/Gemini under appropriate Google Cloud terms or another direct provider contract that forbids training and unrelated secondary use. Google Cloud's current AI/ML terms say Google will not train or fine-tune on Customer Data without permission, but the exact chosen service, region, logging, abuse-monitoring, retention, and assessment boundary still require review. [Google Cloud service-specific terms](https://cloud.google.com/terms/service-terms)

Do not return developer-funded OpenRouter child keys to public CLI users. OpenRouter's Management API can create per-customer keys with limits, but the returned credential is still a copyable bearer key usable outside Gmail Agent. If child keys are used later for provider-side accounting, keep them encrypted and server-side. [OpenRouter Management API keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)

### Researched fallback, blocked for Gmail content: OpenRouter OAuth

OpenRouter supports OAuth with PKCE, localhost callbacks on arbitrary ports, and an authorization-code exchange at `/api/v1/auth/keys`. This removes manual key creation and copying. The resulting durable key is user-controlled and should be stored in the OS credential store, not browser storage. [OpenRouter OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)

If a Limited Use-compatible OpenRouter configuration can be enforced for a user-owned workspace, this path could let a user fund their own usage when the publisher allowance is unavailable. Its UX would be:

1. Connect Google.
2. Choose **Use my OpenRouter account**.
3. Complete a second OpenRouter authorization.
4. Add/buy OpenRouter credits if required.

It satisfies “no manual AI key,” but not “one sign-in and no AI-provider account.” More importantly, the app cannot currently guarantee that a user's OpenRouter workspace has private I/O logging and input/output-use settings disabled. Treat this as researched but **blocked for Gmail content** until a per-request or contractual control makes that guarantee. A disclosure alone does not permit use of Gmail data for generalized provider/model improvement.

### Similar tools considered

Every option that receives Gmail-derived content must pass the same Limited Use, disclosure, retention, training, secondary-use, and security gates; changing billing or gateway vendors does not remove them.

| Option | Manual user AI key? | Separate AI account? | Publisher backend? | Decision |
| --- | --- | --- | --- | --- |
| OpenRouter behind this gateway | No | No | Yes | Strong technical candidate, but blocked until its own anonymous categorization/secondary use is contractually and enforceably disabled for these requests. |
| Vertex AI/Gemini behind this gateway | No | No | Yes | **Recommended starting provider evaluation.** The Google runtime can use service-account credentials and current Cloud terms prohibit training on Customer Data without permission; still validate the exact service controls and terms. |
| Direct OpenRouter OAuth | No | Yes, with credits | No for inference | Technically removes key copying, but blocked for Gmail content until per-user OpenRouter data handling can be enforced. |
| Firebase AI Logic from the CLI | No visible key | No | Provider proxy exists | Do not use as the subsidy boundary for an open-source desktop CLI; App Check/CORS are not reliable proof of an untampered public CLI. It is oriented toward web/mobile clients. |
| Cloudflare AI Gateway Unified Billing | No user key | No | Yes | Technically viable, but adds another vendor/auth token and does not simplify a Firebase deployment enough to beat OpenRouter or Vertex AI. |
| Vercel AI Gateway | No user key | No | Yes | Its zero-configuration OIDC advantage applies on Vercel; Firebase still needs a server credential. |
| Hugging Face OAuth/inference providers | No manual key | Yes | Optional | Technically credible, but adds another account, is a less direct API fit, and still requires enforceable Limited Use-compatible account/provider settings. |
| Local model | No | No | No | Privacy-friendly advanced option, but downloads, hardware, speed, and quality work against the easiest-setup goal. |

The final provider choice must pass both gates: written Limited Use-compatible data handling and the synthetic-message quality/cost test. If one Gemini model meets the classification/drafting contract, Vertex AI removes an extra provider secret and is the leading starting option. If OpenRouter supplies the required enterprise control, its provider/model flexibility and OpenAI API compatibility may justify it. If neither passes, do not launch hosted AI.

## AI gateway contract, including the OpenRouter variant

The gateway must not mirror the OpenRouter API. Define versioned, product-specific operations such as:

- `POST /v1/ai/classify`: accepts one message or a small bounded batch of normalized message facts and returns only the typed classification fields used by the policy engine.
- `POST /v1/ai/draft`: accepts one bounded drafting context and returns draft text only.

For both operations:

- Require an active hosted-AI entitlement and the current consent-policy version before accepting any message-derived input.
- Construct system instructions and the provider request server-side.
- Reject unknown fields, client-selected model IDs, arbitrary provider URLs, tools, images, audio, attachments, remote URLs, and oversized arrays/text.
- Set strict request-body, per-message, context-token, output-token, timeout, concurrency, and retry limits.
- Pin explicit model IDs and a provider/model allowlist. Do not use a free-model router or an automatic fallback that can violate the published data policy.
- If OpenRouter passes the Limited Use gate, use its Responses API with `store: false` where supported. Preserve the current typed Structured Outputs contract only after compatibility tests pass. [OpenRouter Responses API](https://openrouter.ai/docs/api/api-reference/responses/create-responses)
- For OpenRouter, require zero-data-retention routes, deny upstream-provider data collection, and disable private I/O logging and the input/output-use discount setting. These controls are necessary but not sufficient: also obtain the enforceable opt-out from OpenRouter's own anonymous categorization described above. Reject the request if any part of the compliant route is unavailable. [OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr) [OpenRouter provider data collection](https://openrouter.ai/docs/guides/privacy/data-collection)
- Validate the model response again at the gateway and again at the CLI boundary. Malformed, refused, truncated, or ambiguous output fails closed.
- Give the model no Gmail credential, mailbox tool, network tool, or ability to perform an action. The local deterministic policy remains authoritative, and sending/modifying mail still requires the existing safeguards and explicit confirmations.

### Quotas and abuse controls

The publisher-funded service needs all of the following before public access:

- Atomic per-user quota reservation before the provider call and reconciliation afterward.
- Per-minute, daily, and monthly limits; input/output token limits; concurrent-request limits; and IP-level anomaly controls.
- A server-owned entitlement/allowlist for the first beta.
- Provider-side spend limits/guardrails plus a global daily circuit breaker.
- Low initial `maxInstances` and bounded provider concurrency.
- Immediate user block, provider-key rotation, and global kill switches.
- Clear `429`/allowance messages that fall back safely to rules-only rather than retrying endlessly.

Budget alerts are notifications, not hard caps. App Check, CORS, an embedded secret, or package signing cannot stop a modified open-source client from replaying an allowed desktop request. Sustainable broad access eventually needs a paid entitlement or a deliberately small publisher allowance. A user-funded provider flow is only an option if the app can enforce compliant data handling for that account.

### Shared Gmail project quota and cost

A publisher Desktop OAuth client also centralizes Gmail API project quota and future billing exposure. Its client configuration is necessarily public, so a modified client can authorize accounts under the publisher project and make direct Gmail calls that the AI gateway cannot meter.

Google currently documents 1,200,000 quota units per minute per project, 6,000 units per minute per user per project, and an 80,000,000-unit daily project threshold before future charges. Google says over-threshold charging is planned later in 2026 with at least 90 days' notice. These values can change and must be rechecked before launch. [Gmail API usage limits](https://developers.google.com/workspace/gmail/api/reference/quota)

- Model quota units for first sync, incremental sync, preview, cleanup, view, drafting, and Sent-style behavior before launch.
- Preserve bounded scans, incremental history, concurrency limits, truncated exponential backoff, and finite retry ceilings.
- Monitor project and per-user quota errors plus the daily threshold; configure quota reductions/alerts where Google permits them.
- Maintain a Gmail-quota abuse and billing incident procedure, including a release/service notice and replacement-client plan.
- Explicitly accept that the public Desktop OAuth configuration cannot prove that calls came from the official CLI. The AI gateway's entitlement and kill switch do not stop direct Gmail API use.

## Data handling and compliance boundary

This direction changes the present local-only privacy model. The public documentation must say so plainly.

### Data allowed to leave the computer

- The initial short-lived Google ID token used only to bootstrap the Firebase session, followed by short-lived Firebase ID tokens used to authenticate AI requests.
- During preview or cleanup, each unresolved message that reaches AI classification—not only a message individually selected by the user—may contribute sender display name/address, subject, sent date, reader timezone, a derived bulk/list-mail signal, bounded plain-text body or Gmail snippet, and current custom Gmail label names used as classification context.
- For a reply draft: the selected incoming sender/subject, bounded plain-text message or snippet, user guidance, and any separately approved style description.
- For a new-email draft: the recipient, subject, bounded user-written purpose, and any separately approved style description.
- A pseudonymous consent/entitlement receipt: policy version, acceptance timestamp, status/revocation timestamp, and no email address or message content.
- Content-free request metadata needed for quota and operations: pseudonymous user ID, operation, model, token counts, latency, status, and coarse timestamp.

The current writing-style feature separately reads up to 12 recent Sent messages and sends bounded subjects/bodies (roughly 5,000 characters total) to create a persistent derived style summary. That is a distinct transfer of unrelated Sent mail and must not silently ride on classification/drafting consent. For the first hosted release, disable automatic Sent-mail style sampling and use user-written style guidance or a neutral default. If the feature returns later, give it a separate just-in-time disclosure and affirmative action, state the exact sample limit, and treat both the samples and derived profile as Workspace data. Do not silently migrate an existing Sent-derived profile into hosted AI.

### Data that must not leave the computer

- Google refresh token or Gmail access token.
- Gmail API responses unrelated to the current classification/draft operation, including recent Sent messages unless the user separately opted into a precisely disclosed style-learning action.
- Attachments, inline images, raw HTML, or remote content.
- Local SQLite history/action ledger.
- Browser cookies/local storage containing authorization material.
- Provider credentials.

The gateway, Firebase logs, error reporters, traces, WAF/CDN, and analytics must not record request bodies, response bodies, authorization headers, email addresses, subjects, or tokens. Firestore should store only pseudonymous consent/entitlement receipts and counters, with server-only access.

Google permits user-facing Gmail productivity and generative-AI features, but requires explicit consent for the data transfer and prohibits using Workspace data to train or improve a generalized model. Restricted-scope integrations must also defend against prompt injection. Treat all mail text and links as untrusted data, separate instructions from content, give the model no tools, and keep high-impact decisions in deterministic local policy. [Google Workspace API user-data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)

Because `gmail.modify` is restricted and messages processed by a run will pass through the publisher gateway and a model provider, plan for Google's restricted-scope verification and the applicable CASA security assessment. Do not treat the Firebase deployment as a casual public launch. External OAuth Testing is limited to listed test users (up to 100), and grants involving non-basic scopes expire after seven days; an unverified public app also faces user limits. [Google Auth Platform audience/testing rules](https://support.google.com/cloud/answer/15549945) [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

## Barebones Firebase setup page specification

This section specifies the page to build later; this plan does not create HTML, CSS, JavaScript, or Firebase configuration.

### Page map

- `/`: product name, one-sentence purpose, install command, “Already installed? Run `gmail setup`,” and policy/support links.
- `/connect`: the one-screen disclosure and two connection choices. It only enables the buttons when opened by a live CLI session.
- `/success`: “Connected—return to your terminal,” a safe first command, and disconnect/help links.
- `/error`: expired or malformed session guidance; always direct the user to rerun `gmail setup`.
- `/privacy`: accurate data access, transfer, retention, training, deletion, subprocessors, and contact disclosure.
- `/terms`, `/data-deletion`, `/security`, and `/support`: stable URLs required for trust, review, and support.

### Proposed `/connect` copy and wireframe

```text
Gmail Agent

Connect Gmail to use Gmail Agent in your terminal.

Gmail Agent can read and organize mail, prepare replies for your review,
and [if Calendar is retained] see, create, change, and delete events on
Google calendars you own. The product uses that access only for the exact
calendar behavior described in its documentation. It never permanently
deletes mail or sends a reply without its normal review/confirmation rules.

Hosted AI
During a preview or cleanup, unresolved messages may be classified automatically.
For each such message, Gmail Agent may send the sender name/address, subject,
date, timezone, a bulk-mail signal, Gmail label names, and bounded plain-text
body or snippet through [Publisher] to [approved model service and subprocessors].
Drafting sends the message or recipient/subject/purpose you choose. The launch
version does not send recent Sent mail to learn your style. Attachments and Gmail
credentials are never sent. This data is used only for these visible features,
not for generalized training, ranking, categorization, or another secondary use.
Fair-use limits apply.

[ ] I understand that messages processed by a run and content used for drafts
    will be processed by the services described above and in the Privacy Policy.

[ Connect Gmail with hosted AI ]
[ Connect Gmail without hosted AI ]

Privacy · Terms · Data deletion · Security · Support
```

Replace every bracketed statement and verify every provider, retention, and training claim against the final production behavior before publishing. The checkbox is required only for hosted AI. The rules-only button still runs Google OAuth but records AI as off. Do not use dark patterns; both choices must remain legible.

### Page states

- **No CLI session:** buttons disabled; show the exact install and `gmail setup` commands.
- **Ready:** disclosure visible; hosted-AI button disabled until consent is checked; rules-only available.
- **Redirecting:** disable both buttons and show “Opening Google…” to prevent double starts.
- **Expired/invalid:** show no technical token detail; tell the user to rerun `gmail setup`.
- **Success:** show the connected result without putting account/token data in the URL.

### Page security and accessibility

- Plain static HTML/CSS and a very small first-party script; no framework is required.
- No analytics, advertising, tag manager, third-party fonts/scripts, cookies, service worker, or Firebase Auth UI.
- Keep bootstrap state and local port in the URL fragment, never a query string, server log, referrer, or browser storage. Parse them once into memory and immediately remove the fragment from the visible URL with `history.replaceState`.
- Accept only a numeric allowed port and the fixed `127.0.0.1` begin path. Never accept a full callback/redirect URL from the page.
- Use a strict Content Security Policy, `Referrer-Policy: no-referrer`, MIME sniffing protection, frame protection through CSP, conservative Permissions Policy, and `Cache-Control: no-store` for `/connect` and `/success`.
- Use semantic headings, native controls, visible keyboard focus, high contrast, a narrow readable column, and screen-reader status text. Do not depend on color or animation.
- On static/direct visits, never imply that clicking the page alone can connect a terminal that has no active listener.

## Firebase hosting and deployment instructions

These are future implementation instructions, not actions performed by this planning pass.

### 1. Establish production ownership first

1. Choose the legal publisher, permanent product name, support/security/privacy contacts, launch countries/audience, processing region, AI allowance, and maximum monthly spend.
2. Register a custom domain the publisher controls. Use separate Google Cloud/Firebase projects for staging and production.
3. Add multiple protected publisher administrators and keep production access out of personal-only accounts.
4. Decide OpenRouter versus Vertex AI only after the Limited Use and synthetic evaluation gates. If OpenRouter passes, create a dedicated production enterprise account/workspace and key rather than reusing a personal development key.

### 2. Create the Firebase project

1. Create the production Firebase project on the production Google Cloud project.
2. Upgrade it to the Blaze plan before deploying Functions/Cloud Run. Static Hosting can be inexpensive, but a server-side AI gateway requires billing.
3. Install and authenticate the Firebase CLI.
4. From the future web/gateway implementation directory, initialize only what is needed:

   ```sh
   firebase login
   firebase init hosting
   firebase init functions
   firebase init firestore
   ```

5. Choose TypeScript and a currently supported Node runtime for Functions. Use classic Firebase Hosting for the static site; do not introduce App Hosting or a front-end framework for this page.
6. Enable Firebase Authentication for the custom-token CLI session. This is gateway identity only; it is not the Gmail authorization mechanism.

[Firebase Hosting quickstart](https://firebase.google.com/docs/hosting/quickstart) [Cloud Functions for Firebase quickstart](https://firebase.google.com/docs/functions/get-started)

### 3. Configure Google authorization

1. Enable the Gmail API and, only if retained, the Calendar API in the production Cloud project.
2. Configure Google Auth Platform branding, audience, data access, verified domain, home page, privacy policy, terms, and support URLs.
3. Create a **Desktop app** OAuth client for the CLI. The client ID is public and may be embedded in a release; an installed-app client secret is not a confidential security boundary.
4. Configure `/v1/session/bootstrap` to accept Google identity tokens only for that exact client audience, then authenticate AI endpoints with Firebase ID tokens.
5. Keep development and staging OAuth clients separate from production.
6. Complete Google verification and any required security assessment before broadening beyond the controlled test audience.

### 4. Configure the gateway and secrets

1. Implement the narrow function/service contract described above. A 2nd-generation HTTPS Function is adequate for the first bounded, non-streaming release. Use Cloud Run if streaming, longer requests, or finer runtime control becomes necessary.
2. If OpenRouter passes the compliance gate, store its key with Firebase/Google Secret Manager. Always store the pseudonymization secret there, for example:

   ```sh
   firebase functions:secrets:set OPENROUTER_API_KEY
   firebase functions:secrets:set USER_ID_HMAC_KEY
   ```

3. Bind each secret only to the function/service that needs it. Never put it in Hosting assets, committed `.env` files, build arguments, client configuration, or response payloads. [Firebase secret parameters](https://firebase.google.com/docs/functions/config-env)
4. Create Firestore consent/entitlement and quota collections with server-only rules; use Admin SDK access from the gateway, require the current non-revoked policy version, and use atomic transactions for quota reservation.
5. Configure model allowlists and provider privacy guardrails in both the selected provider and the gateway. Do not configure OpenRouter until its own categorization/secondary-use blocker is resolved.
6. Set request size/time limits, low `maxInstances`, concurrency, budget alerts, provider spend thresholds, and a global service-disable switch. Budget alerts alone do not cap spend. [Avoid unexpected Firebase charges](https://firebase.google.com/docs/projects/billing/avoid-surprise-bills)

Use the Function/Cloud Run direct HTTPS URL for calls that may exceed Firebase Hosting's serverless rewrite timeout. A Hosting rewrite is acceptable for short endpoints but should not determine the inference timeout design. [Firebase serverless Hosting limits](https://firebase.google.com/docs/hosting/serverless-overview)

### 5. Stage, preview, and deploy

1. Test only with synthetic or explicitly authorized mail fixtures.
2. Run the Hosting/Functions/Firestore emulators for the page, authentication checks, schema rejection, and quota paths.
3. Deploy the complete service to the separate staging Firebase project.
4. A Hosting preview channel can review static pages, but it does not replace a separately deployed staging gateway:

   ```sh
   firebase hosting:channel:deploy setup-preview
   ```

5. After staging acceptance, deploy the production site and service:

   ```sh
   firebase deploy --only hosting,functions,firestore:rules,firestore:indexes
   ```

6. Connect and verify the custom domain, wait for managed TLS, and use that domain in all Google Auth Platform links. [Firebase custom domains](https://firebase.google.com/docs/hosting/custom-domain)
7. Verify headers, policy URLs, no-content logging, secret access, quota enforcement, provider privacy routing, revocation, and the kill switch in production before inviting users.

## Implementation phases

### Phase 0: make the external decisions

- Choose publisher identity, product name, domain, support contacts, regions, beta audience, funding model, maximum spend, and model/provider.
- Decide whether Calendar is required at launch.
- Decide whether hosted drafting launches without Sent-mail style learning (recommended) or waits for a separate just-in-time consent design.
- Define the hosted-AI allowance and what happens when it is exhausted.
- Obtain written provider data-use terms. OpenRouter's current anonymous categorization is a launch blocker unless it can be disabled contractually and technically.
- Start the Google verification/security-assessment work early; it is likely the schedule-driving item.

Exit: one accountable publisher and a written decision for every item above.

### Phase 1: prove the provider contract with synthetic data

- Compare an explicit OpenRouter model route with Vertex AI/Gemini on representative synthetic classification and drafting cases.
- Treat data handling as a pass/fail test before quality: document provider/subprocessor retention, human access, abuse monitoring, training, anonymous categorization, rankings/reporting, regions, and enforceable controls. Get legal/security confirmation for Google's Limited Use requirements.
- Verify OpenRouter Responses API behavior used by the current code: structured outputs, refusal handling, `store: false`, reasoning settings, timeouts, retry semantics, and provider privacy constraints.
- Measure quality, p50/p95 latency, input/output tokens, and per-mailbox cost.
- Confirm that no compliant route means a hard failure, not a silent privacy downgrade.
- Prove the initial Google ID-token -> verified bootstrap -> Firebase custom token -> Firebase ID/refresh token lifecycle, including consent receipt, revocation, expiry, and policy-version changes.
- Capture the exact current classification, reply, new-email, and Sent-style payloads in contract tests; disable automatic hosted Sent-style sampling for launch.
- Test the hosted HTTPS page-to-HTTP-loopback navigation in current Safari, Chrome, Firefox, and Edge without using cross-origin `fetch` as a hidden dependency.

Exit: one pinned model/provider, one measured cost envelope, one verified identity-token lifecycle, and a recorded go/no-go result.

### Phase 2: publisher Google OAuth release path

- Replace normal user credential-file setup with the release-embedded publisher Desktop client while retaining developer overrides.
- Preserve the current PKCE, random state, loopback-only callback, scope validation, keychain storage, reconnect, and revoke behavior; add and verify an OIDC nonce.
- Add `openid` and only justified scopes.
- Add the hosted-page bootstrap state/mode handoff and fail closed on invalid/expired sessions.
- Keep Google and Firebase refresh tokens distinct in the OS credential store. Rules-only users receive no hosted-AI entitlement.
- Ensure a release with missing publisher configuration refuses to claim zero-setup onboarding.

Exit: a clean machine reaches a connected terminal with one Google consent and no developer configuration.

### Phase 3: barebones hosted setup and policy pages

- Build the page map and exact states specified above.
- Publish accurate privacy, terms, deletion, security, and support pages on the verified custom domain.
- Add security headers, accessibility checks, and a test proving no secrets appear in assets, URLs, storage, or logs.
- Keep the page independent of mailbox operations and AI availability.

Exit: direct visitors get correct instructions; live CLI sessions complete both hosted-AI and rules-only choices.

### Phase 4: authenticated AI gateway

- Build only `/v1/ai/classify` and `/v1/ai/draft` (or equivalent typed operations).
- Add Google-to-Firebase session bootstrap, Firebase identity verification, current-policy consent enforcement, pseudonymous quota storage, atomic reservation/reconciliation, narrow schemas, model/privacy allowlists, response validation, and content-free telemetry.
- Store any provider key in Secret Manager and add rotation/global-disable procedures. When using Vertex AI, grant a least-privilege runtime service account instead of exporting a service-account key.
- Exercise malformed tokens, replay, revoked users, oversized bodies, unknown fields, arbitrary model/tool attempts, rate limits, provider failures, and budget cutoff.
- Begin as an allowlisted staging and beta service.

Exit: a copied request cannot turn the gateway into general-purpose subsidized AI, and failure never causes a Gmail action.

### Phase 5: CLI provider integration and migration

- Add a publisher-gateway AI access mode as the normal release default.
- Keep rules-only as a first-class choice. Keep direct OpenRouter OAuth behind a disabled feature flag unless its user-workspace data handling can be verified per request.
- Adapt current classification/drafting contracts without weakening schema validation or deterministic action policy.
- Disable automatic Sent-mail style sampling for hosted AI at launch; do not reuse an existing Sent-derived profile without the separately approved flow.
- Migrate existing configuration deliberately; never overwrite a working advanced configuration silently.
- Add human-readable allowance, outage, auth-expiry, and privacy-route failure messages.

Exit: classify and draft work without a user AI key; all provider and malformed-output failures are safe and understandable.

### Phase 6: documentation, compliance, and release

- Rewrite claims that currently say there is no server, no hosted account, or mail never leaves the computer. Those statements become false when hosted AI is enabled.
- Document the exact subprocessors, automatic per-run classification behavior, fields sent, Sent-style status, retention, training/secondary-use prohibition, consent receipts, quota data, opt-out, disconnect, and deletion process.
- Complete Google verification and the applicable assessment.
- Add release checks that reject embedded provider keys, development OAuth clients, placeholder policy URLs, missing gateway URL, and secret/content logging configuration.
- Run signed-package tests on clean macOS, Windows, and Linux users.

Exit: the deployed behavior, consent copy, policy pages, CLI help, README, and release artifact all describe the same system.

### Phase 7: conservative launch

- Start with an allowlisted beta and small quotas.
- Monitor only aggregate/content-free availability, latency, error, quota, auth, and spend signals.
- Rehearse gateway shutdown, provider-key rotation, user blocking, incident response, and rollback.
- Expand access only after measured quality, cost, abuse, support, and assessment results are acceptable.

Exit: the publisher can fund, support, revoke, and safely stop the service.

## Repository change map for later implementation

No files below are changed by this plan. Expected areas include:

- Google OAuth and credential lifecycle: `src/auth/google-oauth.ts`, `src/auth/oauth-client-file.ts`, `src/auth/credential-store.ts`, `src/commands/setup-google-client.ts`.
- AI access/configuration: `src/core/ai-access.ts`, `src/core/onboarding.ts`, `src/commands/setup.ts`, `src/commands/setup-ai.ts`, `src/config/schema.ts`.
- Provider contracts: `src/ai/openai-classifier.ts`, `src/ai/draft-reply.ts`, `src/ai/resolve-classifier.ts`.
- Terminal setup/status copy: `src/ui/assets.ts`, `src/ui/operations.ts`, command help, and related tests.
- Public truth and policy: `README.md`, `SECURITY.md`, `site/index.html`, `docs/setup.md`, `docs/commands.md`, `docs/development.md`, and `docs/launch/`.
- New future surfaces: a small Hosting directory, gateway function/service, Firestore rules/indexes, Firebase configuration, deployment tests, and operational runbooks.

The repository previously contained a publisher gateway and short-lived Google ID-token authentication in commit `1bbc8ed`, removed in `0eaf8f8`. Mine that implementation, its tests, release gates, policies, and runbooks selectively; do not blindly revert it. Its narrow schema, model allowlist, `store: false`, quotas, hashed subjects, and content-free logging are relevant, but the provider, Firebase deployment, disclosure, and current source contracts must be re-reviewed.

## Acceptance criteria

### User experience

- On a clean machine, the documented install plus `gmail setup` opens the hosted page automatically.
- One Google consent plus the immediately preceding hosted-AI checkbox connects Gmail and enables the publisher-funded AI mode without a second account popup.
- The user creates no Cloud project, downloads no credentials JSON, opens no OpenRouter account, and enters no API key.
- A rules-only choice is available without manipulative wording.
- Success returns the user to the terminal and does not touch the mailbox.
- The first recommended mailbox operation is bounded and dry-run.

### Authentication and secrets

- OAuth state mismatch, replay, expiry, wrong callback path/host, missing scopes, and denied consent all fail safely.
- Google refresh/access tokens remain in the OS credential store and never reach Firebase or the model service; only the initial Google ID token reaches the session bootstrap endpoint.
- Firebase refresh tokens remain in the OS credential store, and only short-lived verified Firebase ID tokens authenticate AI calls.
- Rules-only users have no hosted-AI entitlement; every hosted request requires a current, non-revoked pseudonymous consent receipt.
- Provider and HMAC keys exist only in Secret Manager/runtime memory and never in the browser, CLI package, source, logs, crashes, or responses.
- Disconnect removes local grants and blocks/invalidates the product session as documented.

### Gateway and AI behavior

- Only typed classify/draft operations are accepted; model, tool, URL, attachment, and unknown-field injection is rejected.
- Input/output/concurrency/quota limits work atomically under parallel requests.
- The selected model service is called only after the Limited Use gate passes. If that service is OpenRouter, its own secondary categorization is contractually disabled in addition to pinned ZDR routes, disabled logging, and `store: false`.
- Structured output is validated; refusals, truncation, timeouts, 429s, 5xx errors, provider outages, and privacy-route failures never trigger uncertain mailbox mutations or sends.
- Publisher allowance exhaustion produces a clear rules-only result; a user-funded option appears only when its account-level data handling can be enforced.
- The global spend circuit breaker and provider-key rotation have been tested.

### Privacy, compliance, and operations

- The immediately visible disclosure matches the actual fields, subprocessors, retention, and training behavior.
- The disclosure says unresolved messages in a run may be classified automatically; it does not misleadingly say only individually selected messages leave the computer.
- Hosted AI does not sample recent Sent mail at launch. Any later style-learning feature has a separate just-in-time disclosure, explicit consent, and bounded sample.
- No message/token content appears in Firebase, Cloud, CDN/WAF, trace, analytics, or provider logs under the configured controls.
- Shared Gmail-project quotas and the daily billing threshold are monitored, modeled, and covered by an incident/disable procedure.
- Google production verification and the applicable security assessment are complete before broad public access.
- Custom-domain policy, deletion, security, support, and terms URLs are stable and tested.
- Synthetic clean-machine acceptance passes on every supported OS.
- Cost, latency, abuse, outage, revocation, deletion, rollback, and incident-response procedures have named owners.

## Decisions to make before any build work

| Decision | Recommended starting answer |
| --- | --- |
| Who pays for default AI? | Publisher, with an allowlisted beta and small fair-use quota. |
| Provider? | Evaluate paid Vertex AI/Gemini first. Use OpenRouter only with an enforceable, written opt-out from its own anonymous categorization and all other secondary content use. |
| User-funded option? | None at launch. OpenRouter OAuth remains researched but blocked until per-user workspace data handling can be enforced. |
| Gateway runtime? | Firebase Functions v2 for bounded non-streaming MVP; Cloud Run when streaming/control requires it. |
| Gateway auth? | Initial Google ID token bootstraps a separately refreshable Firebase session; AI calls use short-lived Firebase ID tokens. |
| Gmail grant location? | CLI/OS keychain only. |
| Firebase Auth for Gmail? | No. |
| Calendar scope? | Omit unless the launch behavior genuinely needs it and can justify it. |
| Sent-mail style learning? | Disabled for hosted AI at launch; redesign as a separate just-in-time opt-in if retained. |
| Public launch? | No until verification, assessment, policies, quotas, monitoring, and kill switch are complete. |

## Official references

### OpenRouter

- [OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)
- [Sign in with OpenRouter reference app](https://github.com/OpenRouterTeam/sign-in-with-openrouter)
- [Responses API](https://openrouter.ai/docs/api/api-reference/responses/create-responses)
- [Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Management API keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)
- [Guardrails](https://openrouter.ai/docs/guides/features/guardrails/overview)
- [Zero Data Retention routing](https://openrouter.ai/docs/guides/features/zdr)
- [Data collection](https://openrouter.ai/docs/guides/privacy/data-collection)
- [Provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging)
- [Pricing](https://openrouter.ai/pricing)

### Google and Gmail

- [OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [OpenID Connect API reference](https://developers.google.com/identity/openid-connect/reference)
- [Gmail OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail API usage limits](https://developers.google.com/workspace/gmail/api/reference/quota)
- [Calendar OAuth scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Workspace API user-data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Google Auth Platform audience/testing rules](https://support.google.com/cloud/answer/15549945)
- [Official Gmail MCP server, Developer Preview](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)

### Firebase and alternatives

- [Firebase Hosting](https://firebase.google.com/docs/hosting)
- [Hosting quickstart](https://firebase.google.com/docs/hosting/quickstart)
- [Functions quickstart](https://firebase.google.com/docs/functions/get-started)
- [Secret parameters](https://firebase.google.com/docs/functions/config-env)
- [Firebase custom tokens](https://firebase.google.com/docs/auth/admin/create-custom-tokens)
- [Firebase Auth REST API](https://firebase.google.com/docs/reference/rest/auth)
- [Verify Firebase ID tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Firebase custom domains](https://firebase.google.com/docs/hosting/custom-domain)
- [Firebase AI Logic](https://firebase.google.com/docs/ai-logic)
- [Vertex AI generative AI quickstart](https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart)
- [Google Cloud service-specific terms](https://cloud.google.com/terms/service-terms)
- [Cloudflare AI Gateway Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [Vercel AI Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok)
- [Hugging Face OAuth](https://huggingface.co/docs/hub/oauth)
