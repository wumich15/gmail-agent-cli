# Google OAuth verification notes

`gmail.modify` is a restricted scope. A public release therefore needs Google's
restricted-scope verification and, because the app handles restricted scope
data on more than a handful of machines, the applicable CASA security
assessment. This is the schedule-driving item; start it before the code is
finished, not after.

None of it applies to a source build, which signs in through an OAuth client
the user registered in their own project, with themselves as the only user.

## Scopes, and the justification for each

| Scope | Why the app cannot work without it |
| --- | --- |
| `https://www.googleapis.com/auth/gmail.modify` | The product *is* mailbox triage: reading headers and bounded body text to classify, then moving messages to Trash, removing `INBOX` to archive, adding `STARRED`/`IMPORTANT`, creating and applying labels, and sending a message the user explicitly confirmed. A read-only scope cannot do any of the organizing, and `https://mail.google.com/` is deliberately not requested because permanent deletion is never performed. |
| `https://www.googleapis.com/auth/calendar.events.owned` | Creating the calendar events the product extracts from mail, and updating only the events it created. Full Calendar access is not requested. |
| `openid` | Only in a build with the included AI service, and only to authenticate the user to that service once. No `email` or `profile` scope is requested: the service identifies users by a keyed hash of the `sub` claim and never learns an address. |

Whether Calendar stays in the launch scope is an open decision
([decisions.md](decisions.md)). Dropping it removes a restricted-adjacent scope
from the review and makes calendar-like mail fail conservatively instead.

## What reviewers usually ask, and where the answer is

- **A demo video showing each scope in use, from a real install.** The flow to
  record: `gmail setup` → the consent page → Google consent → `gmail --dry-run`
  → `gmail` applying a change → `gmail undo` reversing it → `gmail view`
  composing a message and stopping at the confirmation.
- **The privacy policy URL**, on the verified domain: `/privacy` in `hosting/`.
  It must be live and placeholder-free before submission.
- **How Limited Use is honored.** Google user data is used only for the
  user-facing features described in the app and the policy, is not transferred
  except to the subprocessors named there, is not used for advertising, and is
  not used to train or improve generalized models. The provider contract has to
  say this too, in writing, before any real message is sent — see
  [decisions.md](decisions.md).
- **Whether data leaves the user's device and where it goes.** Yes, when the
  user selects the included AI: bounded message fields to the publisher's
  gateway and on to one named model service. Gmail credentials never do, and
  Gmail traffic is never proxied.
- **Prompt-injection handling for restricted-scope integrations.** Message text
  is evidence, never instruction; the model has no tools, no network, and no
  credentials; instructions and content are kept in separate parts of every
  request; a model-asserted date is verified against the message before an
  event is created; a suspicious classification produces no automated action.
- **Security assessment artifacts.** `SECURITY.md` (scope and reporting),
  `docs/operations/` (runbooks and incident response), `firestore.rules`
  (default deny), and the release gates in `scripts/`.

## Testing-mode reality while verification is pending

External Testing is limited to listed test users, and a grant that includes
Gmail scopes expires after seven days. That is workable for a closed beta and
is not workable for public distribution — so the beta allowlist
(`GATEWAY_BETA_ALLOW_LIST`) and the Google test-user list have to be kept
consistent, and beta users need to be told plainly that they will re-sign-in
weekly until verification completes.

## What the app deliberately does not do, and should be stated as such

- Never calls `messages.delete` or `messages.batchDelete`.
- Never creates Gmail filters (no `gmail.settings.basic`).
- Never sends mail without showing the exact recipient, subject, and body and
  receiving an explicit confirmation that defaults to no.
- Never adds Calendar attendees, sends invitations, creates conference links,
  or modifies an event it did not create.
- Never fetches a link found in a message.
- Never uploads or downloads attachments.
