# Security Policy

## Reporting a vulnerability

Open a **private** security advisory on the repository (Security → Report a
vulnerability), or contact the maintainer listed in `package.json`. Please
don't open a public issue for something exploitable.

Include what you found, how to reproduce it, and what an attacker could
achieve. Test against your own Google account and synthetic mail only.

## What this tool is, for scoping purposes

As built from this repository there is no server, no hosted service, and no
publisher-held data. The tool runs on the user's own computer, signs in with an
OAuth client the user registered in their own Google Cloud project, and talks to
the AI provider the user configured with their own key. Gmail and Calendar
traffic goes directly from that computer to Google. So the attack surface is
entirely local plus the two APIs the user chose to connect.

The tree also contains an optional hosted path (`gateway/`, `hosting/`) for
distributing the tool to other people: a gateway exposing exactly two typed
operations, authenticated by a Firebase session separate from the Google grant,
gated on a stored consent receipt, and metered per user. It is not configured
and not enabled, and a build from this source never offers it — it holds no
Google credential, cannot call Gmail, and stores no message content. Findings
in it are welcome but are not reachable by any current install.

## Especially interesting

- Any path where email content, an OAuth token, or an API key reaches a log
  file, the SQLite database, the terminal, or the AI provider when it should
  not.
- Any way content *inside an email* causes an action the user did not confirm —
  prompt injection that escapes the typed assessment boundary, a message that
  triggers a send, or anything that makes the app fetch an attacker-chosen URL.
- Any way a message gets permanently deleted. The app must only ever use
  Gmail's reversible Trash.
- Anything that sends mail without the exact-message confirmation gate.
- Weakening of the unsubscribe client's protections: HTTPS-only, no redirects,
  no private/loopback addresses, DKIM coverage checks on one-click POSTs.

## Out of scope

- Google and OpenAI infrastructure (report to those vendors).
- Findings that require an already-compromised OS user account. Credentials
  live in the OS credential store and the data directory is owner-only; an
  attacker with that account has already won.
- The saved Desktop OAuth client ID and secret. Google documents that an
  installed-app client secret is not confidential, which is why sign-in also
  requires PKCE `S256`, a random `state`, an OIDC nonce, and a loopback-only
  redirect.
- The unconfigured hosted path, for anything that depends on a publisher
  actually operating it. "A modified client could call the gateway" is assumed
  rather than a finding: the boundaries there are the narrow request schema,
  the consent gate, the quota, and Google's own consent screen — never client
  integrity.
