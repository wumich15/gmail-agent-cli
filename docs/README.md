# Documentation

- [Setup and everyday usage](../README.md)
- [All Gmail commands and terminal shortcuts](commands.md)
- [Production OAuth, managed GPT gateway, and release build](production.md)
- [Development, configuration, and performance](development.md)

Publisher/release material (not needed to use the app):

- [Launch decision record](launch/decisions.md) — the placeholders every other launch document uses
- [Home page, privacy policy, terms, data deletion, security policy](launch/) — the public pages Google's consent screen links to
- [Google OAuth verification submission](launch/google-verification.md)
- [Release acceptance checklist](launch/acceptance-checklist.md)
- [Gateway runbooks](operations/runbooks.md) and [incident response](operations/incident-response.md)

The CLI also includes documentation through `gmail help`, `gmail help <command>`, and `gmail view --help`.

`gmail ui` serves a minimal browser front-end — **Setup**, **Commands**, **Status** — from `127.0.0.1` on this computer, for as long as that command runs. It renders the same command reference as this directory, so the two cannot disagree.

There is no hosted documentation site yet, and no live URL to link to. This directory remains the documentation home; a verified public URL belongs at the top of the README when one actually exists.

The [archived program guide](archive/program-guide.md) records an earlier design. It is not setup guidance or a description of the current command surface.
