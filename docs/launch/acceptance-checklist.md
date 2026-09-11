# Release acceptance checklist

Run every item against the **exact signed release artifact**, on a clean OS user
account with no development environment variables and no `OPENAI_API_KEY` — not
against a source checkout. Record evidence (terminal output, screenshots, run
IDs) with the release record.

Repeat on macOS, Windows, and Linux.

## Install and first run

- [ ] Install the signed artifact; `gmail --help` works.
- [ ] Setup shows **Connect Gmail** immediately and never asks for a Cloud
      project, credentials file, or client secret.
- [ ] The consent screen shows the verified publisher, {{PRODUCT_NAME}}, the
      {{DOMAIN}} links, and exactly the four approved scopes.
- [ ] Sign-in completes with a consumer Gmail account.
- [ ] Sign-in completes with a permitted Workspace account.
- [ ] The refresh token is present in the OS credential store and absent from
      `config.json`, `state.sqlite`, and every log file.

## AI options

- [ ] Selecting **Included GPT** works with no OpenAI key: classification and
      drafting both succeed.
- [ ] Setup never offers or probes for a local AI runtime, and never asks a
      production user for an OpenAI key.
- [ ] The AI consent screen states what is sent and the provider-retention
      caveat before anything is sent.
- [ ] **Your own OpenAI API key** still works when supplied deliberately.
- [ ] **Rules-only** mode works and sends nothing off the device.

## Mail behavior

- [ ] `gmail --dry-run` changes nothing: no Trash, archive, label, star,
      calendar event, rule, or cache mutation.
- [ ] A real run against a seeded test mailbox trashes spam/promotions,
      archives read mail, stars and marks important what it should, applies
      labels, and creates the expected calendar event.
- [ ] Nothing was permanently deleted; every trashed message is in Gmail Trash.
- [ ] Uncertain mail received no AI-derived trash, star, or calendar action and
      appears under Review.
- [ ] `gmail undo <run-id>` reverses the reversible actions and reports the
      unsubscribe as irreversible.
- [ ] Kill a run mid-flight (Ctrl-C, then SIGKILL); the next run reconciles
      without duplicate calendar events or lost audit state.

## Sending

- [ ] An AI-drafted reply shows the exact final To/Subject/Body and defaults to
      **no**.
- [ ] Declining sends nothing; there is no flag or shortcut anywhere that skips
      the confirmation.
- [ ] Confirming sends exactly the message shown.

## Failure and recovery

- [ ] Revoke the grant at <https://myaccount.google.com/permissions>; the app
      explains reauthorization is required and re-runs the flow once, without
      looping.
- [ ] Change the account password / expire the grant; reconnect works.
- [ ] Administrator-blocked or partially granted scopes disable or clearly
      report the affected functionality instead of failing obscurely.
- [ ] Gateway 401, 429, timeout, and 5xx each produce an understandable message
      with no provider diagnostics, tokens, or URLs leaked.
- [ ] Gateway unreachable, Google unreachable, network off, credential store
      locked, and database locked each behave understandably.
- [ ] `gmail doctor` reports each of those conditions accurately.

## Disconnect and deletion

- [ ] `gmail auth logout` revokes the Google grant and removes the stored
      credential.
- [ ] `gmail uncache` clears local cache state.
- [ ] Deleting the app data directory removes everything, and a subsequent run
      starts from clean onboarding.
- [ ] Local retention behaves exactly as the published privacy policy says.

## Artifact hygiene

- [ ] `pnpm verify:release` passes on the published artifact.
- [ ] The artifact reports `publisher` OAuth and gateway sources without
      printing their values.
- [ ] No `.env`, local database, diagnostic log, development credential, or
      unreplaced release marker is in the package.
- [ ] Install, upgrade, rollback, and uninstall all tested on each platform.
- [ ] SBOM, checksums, and build provenance archived with the release record.
- [ ] `pnpm test:gpt` passes separately against the publisher's development
      OpenAI project, confirming both configured model IDs still exist.
