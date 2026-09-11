# Incident response plan — {{PRODUCT_NAME}}

Covers the failures most likely to actually happen to this product. Every
procedure referenced here lives in [runbooks.md](runbooks.md).

## Roles

- **Incident lead** — decides, communicates, and owns the timeline.
- **Operator** — executes runbooks; never improvises on production secrets.
- **Communications** — updates the status page and answers {{SUPPORT_EMAIL}}.

One person may hold several roles; name them out loud at the start anyway.

## Severity

| Level | Definition | Response |
| --- | --- | --- |
| **SEV1** | User data exposed, a credential leaked, unexpected Gmail access, or mail damaged | Immediate; page the lead; disable the affected path first, investigate second |
| **SEV2** | Included GPT down or badly degraded for most users | Same business day |
| **SEV3** | Elevated errors, one abusive account, budget threshold crossed | Next business day |

## Leaked publisher OpenAI key

1. **Revoke the key in the OpenAI dashboard first.** Accept the outage; every
   minute it lives is billed to us.
2. Rotate per the runbook and redeploy.
3. Review OpenAI usage for unauthorized spend and request review of charges.
4. Determine the exposure path: CI log, artifact, commit, or host compromise.
   Verify with `pnpm verify:release` that no published artifact contains a key.
5. If a published artifact did contain it, unpublish or deprecate that version,
   ship a fixed one, and disclose.

## Compromised signing or release credentials

1. Revoke the signing credential and the npm publish token immediately.
2. Freeze releases. Disable the `production-release` environment approvals.
3. Compare published artifact checksums and build provenance attestations
   against the release record; any mismatch is a supply-chain incident.
4. Deprecate affected versions, publish re-signed artifacts, and disclose which
   versions and checksums are trustworthy.
5. Re-enable releases only after credentials are reissued under new approvals.

## Unexpected or excessive Gmail access

Applies to any report that the app touched mail it should not have.

1. Treat as SEV1. Ask the reporter for the run ID and the `gmail summary
   <run-id>` output — every mutation is in the durable action ledger.
2. Reproduce against a test mailbox, never the reporter's.
3. If the cause is a classification or policy defect that could trash or send
   mail wrongly, ship a release that raises the affected threshold or disables
   that automation, and tell users to run `gmail undo <run-id>`.
4. Remember the standing invariants when triaging: nothing is ever permanently
   deleted, and nothing sends without a per-message confirmation. A report that
   contradicts either is a top-priority correctness bug.
5. If it stems from prompt injection in message content, add the message to the
   injection fixtures before shipping the fix.

## Abusive gateway use

1. Identify the pattern in the metrics and request logs — which are content-free
   by design, so you are working from outcome classes, rates, and the 12-
   character subject prefix, not from mail or addresses.
2. Block the account (`GMAIL_AGENT_GATEWAY_BLOCKED_ACCOUNTS`) or narrow the
   allowlist; restart.
3. If abuse is broad, tighten per-user limits before disabling the service.
4. Note that a Google identity proves *which account* called, not that an
   official build made the call: the model allowlist, narrow request schema,
   and quotas are the real spend controls.

## Provider outage (Google, OpenAI, or hosting)

1. Confirm with the provider's status page before changing anything.
2. Verify the app degrades as designed: AI failures produce review items, never
   an AI-derived trash, star, or calendar action; deterministic archiving of
   read mail still works.
3. Post a status update with the provider link and an expected next update.
4. Do not rotate keys or roll back during a third-party outage unless evidence
   points at our own change.

## Communication

- Acknowledge publicly within 1 hour for SEV1, 4 hours for SEV2.
- Say what is affected, what users should do, and when you will update next.
- Never publish message content, addresses, or tokens in an incident note.
- For anything involving personal data, notify {{PRIVACY_EMAIL}}'s owner and
  assess notification obligations within the first day, not at the end.

## After the incident

Within five business days: a written timeline, root cause, what detection
missed, and the specific alert, test, or invariant added so the same failure is
caught next time. Close the loop by rehearsing whichever runbook was found
wanting.
