# Google OAuth verification submission

What Google's review team asks for, with the answer this application actually
supports. Fill placeholders from [decisions.md](decisions.md).

## Project setup

- Production Google Cloud project, separate from every development and test
  project. Development keeps using `GMAIL_AGENT_OAUTH_CLIENT_ID` /
  `GMAIL_AGENT_OAUTH_CLIENT_SECRET` with a different project.
- Gmail API and Google Calendar API enabled.
- Multiple trusted publisher contacts with 2-step verification enforced.
- Auth Platform branding: {{PRODUCT_NAME}}, support {{SUPPORT_EMAIL}},
  home `https://{{DOMAIN}}/`, privacy `https://{{DOMAIN}}/privacy`,
  terms `https://{{DOMAIN}}/terms`, verified domain {{DOMAIN}}.
- One **Desktop** OAuth client. Its ID and secret go to the release CI secret
  manager; the same client ID also goes to the gateway's secret manager as
  `GMAIL_AGENT_GATEWAY_GOOGLE_CLIENT_ID` for ID-token audience verification.
- Never use the production client for routine local development or CI tests.

## Scope justification

| Scope | Justification to submit |
| --- | --- |
| `openid` | Authenticates the user to the publisher-operated AI gateway with a short-lived ID token so per-user fair-use limits can be enforced. No Gmail token is ever sent to that service. |
| `email` | Displays which account is connected, and gates the invite-only Included GPT beta. |
| `gmail.modify` | Reads message headers and body text to classify mail on the user's behalf, and applies the resulting label changes: move to Trash, remove `INBOX` (archive), add `STARRED`/`IMPORTANT`, and create/apply topical labels. Also sends a message only when the user explicitly confirms that exact message. The app never calls `messages.delete` or `messages.batchDelete`, so no mail can be permanently deleted. A narrower scope (`gmail.readonly` + `gmail.labels`) cannot apply Trash or send a user-confirmed reply. |
| `calendar.events.owned` | Creates calendar events from mail that states a concrete commitment, and updates or deletes only events this app created (verified by private extended properties). This is narrower than `calendar.events`; full calendar access is not requested. |

## Demo recording checklist

Record one continuous pass showing:

1. Install and first run: the consent screen with the verified publisher,
   product name, and exact scopes.
2. The in-app explanation of what will change, and the separate, opt-in AI
   consent screen including the provider-retention caveat.
3. A dry-run preview that changes nothing.
4. A real cleanup run against a seeded test mailbox: Trash, archive, star,
   important, labels, and a created calendar event.
5. The run summary enumerating every action, and `gmail undo` reversing them.
6. An AI-drafted reply, showing the exact final message and the default-no
   confirmation — including declining it, so it is visible that nothing sends
   on its own.
7. `gmail auth logout`, then the grant gone from
   <https://myaccount.google.com/permissions>.

## Data-handling answers

- **Minimization.** Only sender, subject, date, selected headers, and bounded
  normalized plain text reach the model; scripts, styles, tracking pixels,
  quoted history, and secret-looking URL parameters are stripped first, and the
  remainder is capped by characters and tokens.
- **Attachments are never uploaded** and attachment bytes are not even fetched
  during a normal run.
- **No storage of content.** Message bodies are never written to the local
  database or to logs; the gateway stores no content at all.
- **Isolation.** Every classification is a fresh, stateless Responses API call
  with `store: false`, no tools, and no conversation state. Email text is
  passed only as untrusted input, never as instructions.
- **Transfer.** With Included GPT, text passes through
  `https://{{GATEWAY_HOST}}` ({{GATEWAY_REGION}}) to OpenAI under the
  publisher's account.

## Security assessment

Ask Google, in writing, whether transmitting restricted Gmail content through
the publisher gateway to OpenAI requires the restricted-scope third-party
security assessment for this deployment. **Plan and budget for the assessment
unless Google confirms an exception in writing.** Do not change the OAuth
project's publishing status or widen the audience until every verification
finding is resolved.
