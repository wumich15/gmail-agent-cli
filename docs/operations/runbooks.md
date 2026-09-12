# Gateway runbooks

Operating procedures for the publisher-run AI service. Each one assumes access
to the production Firebase/Google Cloud project and the Firebase CLI.

Everything here affects only the included AI service. None of it can read,
change, or lose anyone's mail: the gateway holds no Google credential and
cannot call Gmail. The worst outcome of any action below is that users fall
back to rules-only cleanup, which is a supported mode.

## Stop the service immediately

The fastest control, and it needs no redeploy:

```sh
firebase functions:config:set   # or set GATEWAY_DISABLED=true on the function
gcloud functions deploy api --update-env-vars GATEWAY_DISABLED=true
```

Every AI request then returns 503 before identity is checked, before Firestore
is touched, and before any paid call. The CLI reports that the service is
unavailable and finishes the run with rules only.

Verify:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<gateway>/v1/ai/classify \
  -H 'content-type: application/json' -d '{"contractVersion":1}'
# expect 503
```

Reverse by setting it back to `false`.

## Rotate the provider key

1. Create the new key in the provider's console; do not delete the old one yet.
2. `firebase functions:secrets:set GATEWAY_PROVIDER_API_KEY`
3. Redeploy the function so it picks up the new secret version.
4. Watch the logs for `outcome: "provider_failed"`; a spike means step 3 did
   not take effect.
5. Revoke the old key at the provider.

Requests in flight during the redeploy fail as `provider_unavailable`, which
the CLI treats as transient and retries. No mailbox action results from it.

## Block one abusive user

The service knows users only by pseudonymous ID, which is what appears in every
log line.

```sh
# Firestore: users/<pseudonymousId>
{ "status": "blocked" }
```

`requireCurrentEntitlement` refuses them on their next request, and a blocked
user cannot re-consent their way back in — `recordConsent` checks the same flag,
so re-running `gmail setup` does not clear a block. To end existing sessions
immediately rather than at the current ID token's expiry, also revoke their
refresh tokens:

```sh
# Firebase Admin: getAuth().revokeRefreshTokens(userId)
```

Verification runs with `checkRevoked: true`, so the next request fails.

## Handle a spend spike

1. Check the logs for `totalTokens` by user; one pseudonym dominating means one
   client, not broad growth.
2. Lower `GATEWAY_QUOTA_PER_DAY` / `_PER_MONTH` and redeploy. Existing users get
   a clear allowance message and a rules-only run.
3. If it is one user, block them (above).
4. If it is broad, reduce `maxInstances` in `gateway/src/index.ts` or set
   `GATEWAY_DISABLED=true` while deciding.

A budget alert is a notification, not a cap. The caps are the per-user quota,
`maxInstances`, `concurrency`, and the provider's own spend guardrail — keep
all four set.

## Change the data disclosure

A substantive change to what is sent, to whom, or for what purpose:

1. Edit the copy in `hosting/connect.html` and `hosting/privacy.html`.
2. Bump `HOSTED_AI_POLICY_VERSION` in `src/auth/publisher-client.ts`.
3. Set `GATEWAY_POLICY_VERSION` to the same value and deploy the gateway.
4. Deploy Hosting and publish a new CLI release.

Between steps 3 and 4, clients holding the old receipt are refused with a
message telling them to re-accept, and their runs continue with rules only.
That is the intended behavior: an old acceptance is never carried forward
across a substantive change, and the cost of the gap is a temporary
downgrade rather than an undisclosed transfer.

A purely editorial change — fixing a typo, clarifying a sentence that does not
alter what happens — does not bump the version.

## Delete a user's records on request

The service holds a consent receipt and usage counters, both keyed to a
pseudonymous ID, and no message content.

1. Confirm the requester, either from the connected Google account or from the
   pseudonymous ID they quote.
2. Delete `users/<id>` and `usage/<id>` in Firestore.
3. Delete the Firebase Auth user, which also invalidates their session.
4. Confirm to the requester, and note that the local side is theirs to clear
   with `gmail setup` → disconnect and `gmail uncache`.

## Roll back a bad deploy

```sh
gcloud functions deploy api --source <previous revision>   # or redeploy the prior tag
firebase hosting:rollback
```

The gateway is stateless apart from Firestore, and the Firestore documents it
writes are forward-compatible (status, policy version, counters), so a rollback
does not strand data. If the rolled-back version serves a different contract
version, clients on the newer CLI are told to upgrade — which is wrong for a
rollback, so prefer fixing forward when a contract version is involved.

## What to watch

Content-free signals only:

- request rate and `outcome` distribution per operation;
- `status` 5xx rate (real failures) versus 4xx (ordinary rejections);
- `durationMs` p50/p95;
- `totalTokens` per day, against the spend model;
- `quota_exceeded` rate, which says whether the allowance is set sensibly;
- `unauthenticated` and `not_entitled` rates, which spike on a policy-version
  mismatch or a bad deploy.

Never add a log field that could carry a subject, sender, body, prompt, model
output, address, or token. `gateway/src/logging.ts` takes a fixed field set for
exactly that reason; widening it is a decision, not a convenience.
