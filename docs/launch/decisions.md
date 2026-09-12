# Launch decision record

The hosted direction needs a set of decisions that no amount of code can make.
This file records them, with the recommended starting answer and the reason, so
that the ones still open are visible rather than assumed.

**Status: not being pursued, and every row below is open.** The implementation
is complete and the service could be deployed, but the tool is currently a
personal, local one: nothing here has an accountable owner, and until these are
answered no build may embed publisher configuration. A build from this
repository has no publisher, says so plainly, and is unaffected by all of it.

## Decisions

| Decision | Recommended starting answer | Why |
| --- | --- | --- |
| Who pays for AI by default? | The publisher, behind an allowlisted beta and a small fair-use quota. | It is the only architecture that delivers one Google consent and no AI account. Paid inference has to be charged to someone; the alternative is a second authorization and a provider account per user. |
| Which model provider? | Evaluate paid Vertex AI/Gemini first. OpenRouter only with an enforceable, written opt-out from its own anonymous prompt categorization and every other secondary use. | Google's Limited Use rules cover anything derived from Gmail scopes. OpenRouter's published data-collection behavior samples a small number of prompts even with logging and input/output-use off, which the per-request ZDR and deny-collection flags do not disable. |
| A user-funded option? | None at launch. OpenRouter's PKCE OAuth flow is researched but blocked. | It removes key copying but not the second account, and the app cannot verify that a user's own workspace has logging and input/output-use disabled — so it cannot promise Limited Use compliance for that path. |
| Gateway runtime? | Firebase Functions v2 for a bounded, non-streaming MVP; Cloud Run when streaming or finer control is needed. | Both operations are short and non-streaming. `gateway/src/app.ts` is transport-agnostic, so the move costs nothing later. |
| Gateway authentication? | The initial Google ID token bootstraps a separately refreshable Firebase session; AI calls carry short-lived Firebase ID tokens. | Google's ID token expires in an hour and cannot be renewed without spending the Gmail refresh token, which never leaves the user's computer. A separate session is also separately revocable in both directions. |
| Where does the Gmail grant live? | The user's OS credential store, only. | The publisher must never be able to read anyone's mailbox, and a stored refresh token on a server is exactly the asset that makes that possible. |
| Firebase Auth as the Gmail authorization? | No. | A Firebase refresh token refreshes Firebase identity, not durable Gmail access; the terminal still needs Google's offline authorization-code grant. |
| Calendar scope? | Omit unless the launch behavior genuinely needs it. | `calendar.events.owned` authorizes event access on *all* calendars the user owns, which is broader than its name suggests, and every extra scope raises the verification bar. |
| Sent-mail style learning? | Disabled under hosted AI at launch. Redesign as a separate just-in-time opt-in if it returns. | It reads a dozen unrelated messages the user did not select for the draft in front of them. That is a materially different transfer and must not ride along on the classification/drafting consent. |
| Public launch? | Not until verification, the security assessment, policy pages, quotas, monitoring, and the kill switch are all complete. | `gmail.modify` is a restricted scope and the mail passes through a publisher service and a model provider. |
| Beta audience control? | Pseudonymous user IDs in `GATEWAY_BETA_ALLOW_LIST`. | The CLI does not request the `email` scope, so the service has no address to allowlist — and should not acquire one merely to run a beta. |

## Still to fill in before a release

- Legal publisher, permanent product name, registered domain, launch countries.
- Privacy, security, legal, and support contact addresses.
- Processing region and retention periods.
- The fair-use allowance and what happens when it is exhausted (currently:
  a clear message and a rules-only run).
- Maximum monthly spend, the provider spend guardrail, and who is paged.
- Named owners for cost, latency, abuse, outage, revocation, deletion,
  rollback, and incident response.

Every bracketed placeholder in `hosting/` corresponds to one of these.
`scripts/verify-hosting.mjs` fails the deploy while any remains, because a
consent screen that names "[Publisher]" is a disclosure nobody can act on
attached to a real authorization.

## Things that are decided, and are in the code

- The gateway exposes two typed operations and no proxy route. A caller cannot
  name a model, a tool, a provider, or an endpoint.
- Consent is versioned. A substantive change to the disclosure bumps
  `HOSTED_AI_POLICY_VERSION`, which stops the gateway from accepting message
  text until the user accepts the new one.
- The user's own registered OAuth client outranks the publisher's, so an
  upgrade never silently moves an advanced configuration onto the publisher's
  project and quota.
- Rules-only is a first-class choice on the disclosure page, with the same
  visual weight as hosted AI and no dark patterns.
- Nothing about outbound mail changed: every send still ends at the same
  exact-message confirmation, defaulting to no.
