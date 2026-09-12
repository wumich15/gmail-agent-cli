# Incident response

For incidents involving the publisher-operated AI service. Local-only installs
(a user's own key, or no AI) have no publisher component and are out of scope
here; a bug in the CLI itself is handled through the normal security policy.

## First moves, in order

1. **Stop the bleeding.** `GATEWAY_DISABLED=true` (see
   [runbooks](runbooks.md#stop-the-service-immediately)) ends every AI
   operation before identity, Firestore, or any paid call. Users fall back to
   rules-only cleanup, which is a supported mode — turning the service off is
   never the risky option.
2. **Preserve evidence.** Export the relevant Cloud Logging window before
   anything is redeployed. The logs are content-free by construction, so
   exporting them cannot leak mail.
3. **Establish blast radius in the right units.** The questions that matter are
   whether message content could have been stored, logged, or sent somewhere it
   should not have been, and whether anyone's Google credentials could have
   been exposed. The second has a structural answer: the service never receives
   them.
4. **Decide on notification early**, not after the fix. If message content
   reached an unintended destination, users have to be told regardless of how
   quickly it was closed.

## Scenarios

### A provider key leaked

The key can only spend the publisher's money; it grants no access to anyone's
mailbox or to the gateway's data.

Rotate it (runbooks), revoke the old one at the provider, and review provider
billing for unexplained usage. If the leak was through a log or a response
body, that is a second, more serious finding — fix the path that emitted it
before redeploying.

### Message content appeared in a log, a database, or an error report

Treat as a privacy incident.

1. Disable the service.
2. Identify every sink that received it: Cloud Logging, Firestore, Error
   Reporting, traces, and anything downstream of log export.
3. Purge it, and record what was purged and when.
4. Fix the emitting path. `gateway/src/logging.ts` exists so there is exactly
   one function that writes a log line and it takes a fixed field set — if
   content escaped, either that was bypassed or a field was widened.
5. Notify affected users and, where applicable, Google, per the restricted-scope
   commitments. Users are identified only by pseudonymous ID, so notification
   runs through the CLI and the site rather than by email from the service.

### The consent gate failed open

A path that accepted message text without a current, non-revoked receipt is a
launch-blocking defect even if no content was mishandled: the disclosure is the
legal basis for the transfer.

Disable the service, write a test that fails on the specific path, fix, and do
not re-enable until that test is in `tests/unit/gateway.test.ts` and passing.

### The gateway was used as general-purpose model access

Symptoms: token counts far above the classification profile, or requests
succeeding with bodies that do not look like the contract.

Disable, then determine which validation was bypassed. The contract schemas are
`.strict()` and bounded; a success with unknown fields means schema validation
was skipped or reordered. Re-check that validation still happens *after*
entitlement and *before* the provider call. Block the users involved, rotate
the provider key if the volume warrants it, and lower quotas before
re-enabling.

### Google flags the OAuth app, or verification lapses

Users cannot sign in and the beta must stop expanding.

Respond to Google promptly with the requested artifacts (scope justification,
privacy policy, demo video, security assessment). Existing signed-in users keep
working until their grant expires. Communicate on the site's support page
rather than silently letting sign-ins fail.

### Gmail project quota exhaustion or unexpected billing

The publisher's Desktop OAuth client centralizes Gmail quota across every user
of a release, and its configuration is necessarily public — a modified client
can authorize accounts under the publisher project and make Gmail calls the AI
gateway cannot see or meter.

Monitor project and per-user quota errors and the daily threshold. If a single
project is being abused, the remedies are a replacement OAuth client in a new
release and a service notice; there is no way to meter Gmail calls from the
gateway, and pretending otherwise would be the wrong plan to rehearse.

## After it is over

- Write what happened, what the actual impact was, what the fix was, and which
  check should have caught it.
- Add that check. A runbook step is not a substitute for a test.
- Review whether the disclosure still matches reality. If the incident changed
  what the service does with data, the policy version has to move and users
  have to re-accept.
- Rehearse the controls that were not used this time: key rotation, user
  blocking, rollback, and deletion requests all decay if they are only ever
  read about.
