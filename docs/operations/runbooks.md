# Gateway and release runbooks

Procedures for the publisher-operated parts of {{PRODUCT_NAME}}. Each one is
written to be followed under pressure by someone who did not write it. Rehearse
each at least once before launch — an untested runbook is a guess.

Common context:

- Service: `gmail-ai-gateway`, single instance, HTTPS at `https://{{GATEWAY_HOST}}`.
- Health: `GET /health` → `{"ok":true}`. Draining or stopped instances return
  503 or refuse the connection.
- Metrics: `GET /metrics` (Prometheus text; bearer token when
  `GMAIL_AGENT_GATEWAY_METRICS_TOKEN` is set).
- Quota store: SQLite at `GMAIL_AGENT_GATEWAY_DB`, mode `0600`, private volume.
- **The gateway runs as exactly one instance while it uses SQLite.** Before
  scaling horizontally, replace the quota store with a shared transactional
  database or distributed rate limiter and add concurrency tests; two instances
  on separate SQLite files silently double every user's quota.

## Deploy

1. Confirm CI is green on the commit being deployed.
2. Deploy the new revision with the existing secrets. Keep the previous
   revision available for rollback.
3. Wait for `GET /health` → 200 on the new revision.
4. Watch `gmail_agent_gateway_outcomes_total{outcome="upstream_error"}` and the
   HTTP 5xx rate for 15 minutes.
5. Send SIGTERM to the old instance. It stops accepting new work, lets in-flight
   OpenAI calls finish (default 15 s grace), then exits — so no user is billed
   for a completion they never receive.

## Rollback

1. Redeploy the previous known-good revision with unchanged secrets.
2. Verify `/health`, then a real end-to-end classification from a test account.
3. If the bad revision changed the quota schema, restore the database from
   backup (below) before sending traffic.
4. Record what was rolled back and why in the incident log.

## Database restore

1. Stop the gateway (SIGTERM; it drains).
2. Copy the most recent backup over `GMAIL_AGENT_GATEWAY_DB`, including any
   `-wal`/`-shm` siblings, preserving mode `0600` and ownership.
3. Start the gateway and confirm `/health`.
4. Expect quota counters to reflect the backup's point in time: users may have
   slightly more or less allowance for one window. This is acceptable; losing
   the whole file is not, because it would reset everyone's daily limit.
5. Verify backups restore cleanly on a schedule, not only during an incident.

## Rotate the OpenAI API key

1. Create a new key in the publisher's OpenAI project. Do not delete the old
   one yet.
2. Update `OPENAI_API_KEY` in the hosting platform's secret manager.
3. Restart or redeploy the gateway so the new value is loaded.
4. Confirm a real classification succeeds end to end.
5. Revoke the old key and confirm OpenAI usage continues on the new one.
6. If the rotation is because a key leaked, revoke first and accept the outage —
   an exposed key is billed to us until it is revoked.

## Rotate the subject HMAC key

`GMAIL_AGENT_GATEWAY_SUBJECT_HMAC_KEY` is what makes stored quota identifiers
pseudonymous.

1. Generate a new value: `pnpm gateway:secret` (CSPRNG, base64url). Never reuse
   the documentation example.
2. Update the secret and restart.
3. **Rotating resets pseudonymous continuity**: existing rows no longer match
   any user, so every user starts a fresh quota window. Rotate during a low
   window, or clear the `ai_usage` table at the same time to avoid carrying
   orphaned rows.
4. Rotate immediately if the key may have leaked — with it, an attacker holding
   the database could link a known Google subject to its usage rows.

## Replace the OAuth client

1. Create the replacement Desktop client in the production Google project.
2. Add the new client ID to the gateway's `GMAIL_AGENT_GATEWAY_GOOGLE_CLIENT_ID`
   and restart, so tokens from both old and new builds verify during the
   transition (run the old value until old builds are drained).
3. Update the release CI secrets and cut a new signed release.
4. Only after installed clients have updated, remove the old client ID and
   delete the old client in Google Cloud. Deleting it earlier breaks sign-in
   for every user still on the old build.

## Emergency service disablement

When abuse, a leaked key, or runaway spend requires stopping Included GPT now:

1. Fastest, least damaging: set `GMAIL_AGENT_GATEWAY_REQUESTS_PER_MINUTE=0`-
   equivalent by moving the audience to an empty allowlist —
   `GMAIL_AGENT_GATEWAY_ALLOWED_ACCOUNTS` set to a single internal address —
   and restart. Every other account gets a clean 403 and the app falls back to
   its non-AI behavior.
2. To block one abusive account only, add it to
   `GMAIL_AGENT_GATEWAY_BLOCKED_ACCOUNTS` and restart. The blocklist always
   wins over the allowlist.
3. Full stop: scale the service to zero. Clients see a connection failure and
   report that AI is unavailable; mail cleanup rules, archiving, and Gmail's own
   spam handling keep working, and no mail is mishandled.
4. Revoke the OpenAI key as well if the cause is a leak.
5. Post status per the incident-communication process and say when you will
   next update.

## Budget response

1. OpenAI billing alerts fire at the thresholds set in the launch decisions.
2. First response: lower `GMAIL_AGENT_GATEWAY_REQUESTS_PER_DAY` and restart.
3. Second: narrow the audience allowlist to the beta group.
4. Third: disable Included GPT as above.
5. Review `gmail_agent_gateway_outcomes_total` by outcome and the per-subject
   row counts in `ai_usage` to tell organic growth from a single heavy account.
