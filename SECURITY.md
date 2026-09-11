# Security Policy

## Reporting a vulnerability

Open a **private** security advisory on the repository (Security → Report a
vulnerability), or contact the maintainer listed in `package.json`. Please
don't open a public issue for something exploitable.

Include what you found, how to reproduce it, and what an attacker could
achieve. Test against your own Google account and synthetic mail only.

## What this tool is, for scoping purposes

There is no server, no hosted service, and no publisher-held data. The tool
runs on the user's own computer, signs in with an OAuth client the user
registered in their own Google Cloud project, and talks to the AI provider the
user configured with their own key. So the attack surface is entirely local
plus the two APIs the user chose to connect.

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
  requires PKCE `S256`, a random `state`, and a loopback-only redirect.
