# Security Policy — {{PRODUCT_NAME}}

Publish at `https://{{DOMAIN}}/security` and mirror it as `SECURITY.md` in the
repository so both the consent screen and the source tree point to one process.

## Reporting a vulnerability

Email **{{SECURITY_EMAIL}}**. Include what you found, how to reproduce it, and
what an attacker could achieve. If you need encryption, request our current
public key in the first message.

Please do not open a public issue, test against another person's mailbox, run
automated scans against `https://{{GATEWAY_HOST}}`, or attempt denial of
service. Use your own account and synthetic mail.

## Our commitments

| Stage | Target |
| --- | --- |
| Acknowledgement | 2 business days |
| Initial assessment | 5 business days |
| Fix or documented mitigation for a critical issue | 30 days |
| Credit in release notes (if you want it) | With the fix |

We will not pursue legal action for good-faith research that respects the
limits above.

## In scope

- The published `{{PRODUCT_NAME}}` packages and release artifacts.
- The Included GPT gateway at `https://{{GATEWAY_HOST}}`.
- The OAuth flow, credential storage, and local database handling.

## Out of scope

- Google and OpenAI infrastructure (report to those vendors).
- Findings that require a compromised operating-system account. The desktop
  OAuth client ID and secret shipped in the package are not a secret — Google
  documents this for installed apps, which is why the app additionally requires
  PKCE `S256`, a random `state`, and a loopback-only redirect.
- Social engineering, physical attacks, and volumetric denial of service.

## Especially interesting to us

- Any path where email content, an OAuth token, or an API key reaches a log,
  the local database, or the AI provider when it should not.
- Any way content inside an email causes an action the user did not confirm —
  prompt injection that escapes the typed assessment boundary, a message that
  triggers a send, or a fetch of an attacker-chosen URL.
- Any way to use the gateway as a general-purpose AI endpoint, to bypass its
  model allowlist or quotas, or to read another user's usage.
