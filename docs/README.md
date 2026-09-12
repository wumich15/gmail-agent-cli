# Documentation

- [Setup: connecting the tool to your own Google account](setup.md) — start here
- [Setup and everyday usage](../README.md)
- [All Gmail commands and terminal shortcuts](commands.md)
- [Development, configuration, and performance](development.md)
- [Security policy and reporting](../SECURITY.md)

### Not used by this install

The tree also contains an optional hosted path — a shared Google app, a setup
site, and a publisher-funded AI gateway — so that the tool *could* be
distributed to other people. It is not configured, not enabled, and not offered
by a build from this source. The documentation below exists for that code and
is irrelevant to running the tool locally:

- [Running and deploying the hosted service](production.md)
- [Launch decision record](launch/decisions.md) — every decision it would need, all still open
- [Hosted-release acceptance checklist](launch/acceptance-checklist.md)
- [Google OAuth verification notes](launch/google-verification.md)
- [Gateway runbooks](operations/runbooks.md) and [incident response](operations/incident-response.md)

The CLI also includes documentation through `gmail help`, `gmail help <command>`, and `gmail view --help`.

`gmail ui` serves a minimal browser front-end — **Setup**, **Commands**, **Status** — from `127.0.0.1` on this computer, for as long as that command runs. It renders the same command reference as this directory, so the two cannot disagree.

The public page at <https://wumich15.github.io/gmail-agent-cli/> is the short pitch and install path, published from `site/` by `.github/workflows/pages.yml`. This directory is the full documentation; the two are separate on purpose, so the landing page stays short.

The [archived program guide](archive/program-guide.md) records an earlier design. It is not setup guidance or a description of the current command surface.
