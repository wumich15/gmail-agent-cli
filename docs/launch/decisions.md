# Launch decision record

Every other document in `docs/launch/` and `docs/operations/` uses the
placeholders below. Fill this file in once, then replace the same placeholders
everywhere else — that is the only way the CLI, the Google consent screen, the
website, and the privacy policy end up describing the same product, which
Google's verification review explicitly checks.

Nothing here is a secret. Real secrets live only in the release CI secret
manager and the gateway hosting platform's secret manager.

| Placeholder | Decision | Status |
| --- | --- | --- |
| `{{PRODUCT_NAME}}` | *(the name shown in the CLI, consent screen, website, and package metadata)* | ☐ decided |
| `{{PUBLISHER_LEGAL_NAME}}` | *(the legal entity that owns the Cloud project, OpenAI account, domain, and signing credentials)* | ☐ decided |
| `{{DOMAIN}}` | *(verified production domain, e.g. `example.com`)* | ☐ verified in Google Search Console |
| `{{SUPPORT_EMAIL}}` | *(e.g. `support@{{DOMAIN}}`)* | ☐ created |
| `{{SECURITY_EMAIL}}` | *(e.g. `security@{{DOMAIN}}`)* | ☐ created |
| `{{PRIVACY_EMAIL}}` | *(e.g. `privacy@{{DOMAIN}}`)* | ☐ created |
| `{{GOOGLE_VERIFICATION_CONTACT}}` | *(the address Google's review team corresponds with)* | ☐ created |
| `{{GATEWAY_HOST}}` | *(e.g. `ai.{{DOMAIN}}`)* | ☐ deployed |
| `{{GATEWAY_REGION}}` | *(where email text is processed, e.g. `us-east`)* | ☐ decided |
| `{{EFFECTIVE_DATE}}` | *(date the published policies take effect)* | ☐ decided |

## Audience and availability

- Launch countries or organizations: ________________
- Included GPT availability: ☐ every user ☐ allowlisted beta ☐ paid users ☐ limited beta
  - The gateway enforces this with `GMAIL_AGENT_GATEWAY_ALLOWED_ACCOUNTS` /
    `GMAIL_AGENT_GATEWAY_BLOCKED_ACCOUNTS` (exact addresses or `@domain`
    entries). Leaving the allowlist empty means general availability.
- Monthly OpenAI budget ceiling: ________________
- Per-user fair-use policy: ______ requests/minute, ______ requests/day
  (`GMAIL_AGENT_GATEWAY_REQUESTS_PER_MINUTE` / `..._PER_DAY`; defaults 120 and
  2,500).

## Approved OAuth scopes

These four are the minimum the application actually uses. Adding a scope means
redoing verification, so treat this list as a gate, not a default.

| Scope | Why it is required |
| --- | --- |
| `openid` | Identifies the signed-in account to the publisher gateway with a short-lived ID token. |
| `email` | Shows the connected address in the app and enforces beta access on the gateway. |
| `https://www.googleapis.com/auth/gmail.modify` | Read message metadata/content for triage, and apply Trash, archive, star, important, and label changes. Never permanent deletion — the app does not call `messages.delete` or `batchDelete`. |
| `https://www.googleapis.com/auth/calendar.events.owned` | Create and manage only the events this app itself created on the user's primary calendar. |

Explicitly **not** requested: `https://mail.google.com/`, Gmail settings
scopes, Drive, Contacts/People, or full Calendar access.

## Exit criteria

- [ ] One legal publisher, one verified domain, one product name.
- [ ] A launch audience and an AI budget.
- [ ] The scope list above reviewed and approved.
