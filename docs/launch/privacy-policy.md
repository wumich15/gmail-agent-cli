# Privacy Policy — {{PRODUCT_NAME}}

**Publisher:** {{PUBLISHER_LEGAL_NAME}}  ·  **Effective:** {{EFFECTIVE_DATE}}  ·  **Contact:** {{PRIVACY_EMAIL}}

Publish this at `https://{{DOMAIN}}/privacy` before submitting Google OAuth
verification, and keep it consistent with what the application actually does —
Google's review compares the two, and so will users.

## What {{PRODUCT_NAME}} is

{{PRODUCT_NAME}} is a program you install and run on your own computer. It
signs in to your Google account with your permission, triages your Gmail inbox,
and creates calendar events from mail that clearly describes a commitment.
There is no server that watches your mailbox: nothing happens unless you run
the app.

## Google data we access, and why

We request four permissions and no others:

| Permission | What it lets the app do |
| --- | --- |
| `openid`, `email` | Identify your account and show which address is connected. |
| Gmail modify (`gmail.modify`) | Read your messages to triage them, and move mail to Trash, archive it, star it, mark it important, or apply labels. |
| Calendar events owned (`calendar.events.owned`) | Create and manage only the calendar events this app created. |

The app **never permanently deletes mail**. Everything it removes from the
inbox goes to Gmail's Trash, where you can restore it, or is simply archived.
It never sends email without showing you the exact recipient, subject, and body
and receiving your explicit confirmation first.

## Where your data is stored

Your Gmail data stays on your computer:

- **Sign-in credentials.** Your Google refresh token is stored in your
  operating system's credential store (macOS Keychain, Windows Credential
  Manager, or Linux Secret Service). It is never written to a config file, a
  database, or a log.
- **Local database.** A SQLite database in your user profile records message
  IDs, labels, content hashes, classification results, rules you created, and
  an audit ledger of every action taken. **Message bodies are never stored**,
  and neither are subjects of the kind that would reconstruct your mail.
- **Diagnostic logs.** Local logs record run IDs, counts, timings, error
  classes, and hashed identifiers. They do not contain message bodies,
  subjects, senders, credentials, tokens, or URLs.

Locations:

- macOS: `~/Library/Application Support/gmail-agent-cli/`
- Windows: `%APPDATA%\gmail-agent-cli\`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/gmail-agent-cli/`

You can delete all of it at any time (see *Deleting your data*).

## AI processing, if you turn it on

AI features are **off until you choose them**, and you are shown what each
option sends before you choose it.

**Included GPT** routes AI requests through a service {{PUBLISHER_LEGAL_NAME}}
operates at `https://{{GATEWAY_HOST}}` (processed in {{GATEWAY_REGION}}), which
forwards them to OpenAI using our own OpenAI account. When it is enabled:

- What is sent: the sender, subject, date, selected headers, and a bounded,
  plain-text excerpt of the message being classified; for a draft you asked
  for, the message you are replying to plus your instructions and a short,
  non-verbatim description of your writing style.
- What is never sent: **attachments**, your Gmail access token, your Gmail
  refresh token, your password, whole mailboxes, or any request the app itself
  did not construct.
- Every request is stateless and sets `store: false`, so OpenAI does not retain
  it as application state. OpenAI's standard abuse-monitoring retention can
  still apply. We disclose this plainly rather than claiming zero retention;
  zero retention applies only where separately approved by OpenAI.
- The gateway authenticates you with a short-lived Google ID token, stores a
  **pseudonymous** identifier (an HMAC hash of your Google account's stable
  subject ID, never your email address) with request timestamps to enforce fair
  use, and keeps those quota records for no more than 7 days.
- The gateway does not log message text, prompts, model responses, or your ID
  token. Its logs record request IDs, timings, HTTP statuses, model names, and
  outcome classes only.

**Your own OpenAI API key** sends the same bounded content directly to OpenAI
under your own account and billing; our gateway is not involved.

**No AI — rules only** sends nothing anywhere. Gmail's own spam handling, your
rules, and archiving of read mail still work.

Text found inside your email is always treated as untrusted data. The app never
follows instructions contained in a message, and the AI model has no ability to
send mail, delete mail, browse the web, or call any tool.

## Who else processes your data

| Processor | Role | When |
| --- | --- | --- |
| Google LLC | Source of your Gmail and Calendar data | Always |
| {{PUBLISHER_LEGAL_NAME}} | Operates the Included GPT gateway | Only with Included GPT enabled |
| OpenAI, L.P. | Generates classifications and draft text | Only with an AI option enabled |

We do not sell your data, use it for advertising, or use your email content to
train any model.

## Deleting your data and disconnecting

- `gmail auth logout` revokes the app's access to your Google account and
  erases the stored credential.
- `gmail uncache` clears the local message cache.
- Deleting the application data directory above removes the local database,
  configuration, and logs entirely.
- You can revoke access at any time, independent of this app, at
  <https://myaccount.google.com/permissions>.
- To have publisher-held gateway quota records deleted sooner than their 7-day
  expiry, write to {{PRIVACY_EMAIL}}. Because those records are pseudonymous,
  we may need you to sign in so the request can be matched to an identifier.

Full procedure: `https://{{DOMAIN}}/delete-my-data`.

## Security

Report a vulnerability to {{SECURITY_EMAIL}}; see
`https://{{DOMAIN}}/security`. Contact {{PRIVACY_EMAIL}} for any privacy
request. We respond to both within the targets published on those pages.

## Changes

We will post changes here with a new effective date, and will ask for consent
again before sending any category of data we do not send today.
