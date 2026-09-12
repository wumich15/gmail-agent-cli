# Hosted-release acceptance checklist

What has to be true before a build embedding publisher configuration is
published. Each item is phrased so it either passes or does not; "looks fine"
is not a state.

Items marked **(automated)** are enforced by a script or a test and will fail a
release on their own. The rest are human checks against a staging deployment.

## User experience

- [ ] On a clean machine, `npm install --global gmail-agent-cli` then
      `gmail setup` opens the hosted page automatically.
- [ ] One Google consent, plus the checkbox immediately above it, connects
      Gmail and enables the included AI with no second account and no popup.
- [ ] The user creates no Cloud project, downloads no credentials file, and
      types no API key.
- [ ] Choosing "Connect Gmail without hosted AI" completes sign-in, records AI
      as off, and is not worded or styled as the wrong answer.
- [ ] Finishing setup touches no mail, and the terminal recommends a bounded
      dry run rather than starting one.
- [ ] `gmail doctor` on that machine reports the OAuth client source, the
      hosted session, and whether AI is actually ready.

## Authentication and secrets

- [ ] OAuth state mismatch, a replayed `/begin`, an expired session, a wrong
      callback path, missing scopes, and a denied consent each fail safely and
      say what to do.
- [ ] Google refresh and access tokens never leave the machine; only the
      one-time Google ID token reaches `/v1/session/bootstrap`.
- [ ] The Firebase refresh token is stored under its own credential-store key
      and is dropped by disconnect, independently of the Google grant.
- [ ] A rules-only user has no entitlement document, and every hosted request
      requires a current non-revoked receipt.
- [ ] The provider key and HMAC key exist only in Secret Manager and runtime
      memory — never in the browser, the package, the source, a log, or a
      response. **(automated: `pnpm verify:package`)**
- [ ] A user who registered their own OAuth client keeps it after upgrading to
      a release that embeds the publisher's. **(automated: `tests/unit/hosted-ai.test.ts`)**

## Gateway

- [ ] Only the four documented paths respond; `/v1/responses` and
      `/v1/chat/completions` are 404. **(automated: `tests/unit/gateway.test.ts`)**
- [ ] Unknown fields, oversized text, oversized label arrays, and an attempt to
      name a model are rejected. **(automated)**
- [ ] The kill switch and a contract-version mismatch are answered before
      identity verification. **(automated)**
- [ ] Quota reservation is atomic under parallel requests, and a reservation is
      refunded only for a request the provider provably rejected.
- [ ] A refusal, a truncation, a timeout, a 429, a 5xx, and a privacy-route
      failure each produce a typed `ok: false` — and no mailbox mutation.
- [ ] Allowance exhaustion produces a clear message and a rules-only run.
- [ ] The global spend circuit breaker and provider-key rotation have been
      exercised on staging, not just documented.

## Privacy and compliance

- [ ] The disclosure names the actual fields, subprocessors, retention, and
      training/secondary-use position, and matches `hosting/privacy.html`.
- [ ] The disclosure says plainly that unresolved messages in a run may be
      classified automatically — not only messages selected one at a time.
- [ ] Hosted AI does not sample Sent mail, and an existing Sent-derived profile
      is not migrated into it. **(automated: `tests/unit/hosted-ai.test.ts`)**
- [ ] No message content, token, address, or raw provider error appears in
      Cloud Logging, Firestore, Error Reporting, traces, or the CDN.
      **(partly automated: `tests/unit/gateway.test.ts` pins the log fields)**
- [ ] Every policy page is live on the custom domain with no placeholders.
      **(automated: `node scripts/verify-hosting.mjs`)**
- [ ] `HOSTED_AI_POLICY_VERSION` and `GATEWAY_POLICY_VERSION` are equal, and a
      deliberate mismatch was tested to confirm it forces re-consent.
- [ ] Google restricted-scope verification and the applicable security
      assessment are complete.
- [ ] Gmail project quota and the daily billing threshold are monitored, and
      the abuse/billing procedure has a named owner.

## Truthfulness of the published material

- [ ] README, `docs/`, the site, `gmail help`, and the consent screen all
      describe the same system. No surviving claim that mail never leaves the
      computer, that there is no server, or that there is no hosted account.
- [ ] The cost text matches the configured allowance.
- [ ] Support, privacy, security, terms, and deletion URLs resolve and are
      stable.

## Release mechanics

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm gateway:typecheck` pass.
- [ ] `pnpm embed:release` ran, and `pnpm verify:package` reports a release
      build with well-formed configuration. **(automated)**
- [ ] A packed tarball installs and runs on clean macOS, Windows, and Linux
      users.
- [ ] The published npm version matches the deployed gateway's contract
      version.
