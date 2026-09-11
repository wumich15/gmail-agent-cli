# Deleting your data and disconnecting {{PRODUCT_NAME}}

Publish at `https://{{DOMAIN}}/delete-my-data`. Google's verification review
requires a public, specific procedure — not a generic contact form.

## 1. Disconnect Google access

```sh
gmail auth logout
```

This revokes the app's OAuth grant with Google where possible and erases the
refresh token from your operating system's credential store. You can confirm,
or revoke independently, at <https://myaccount.google.com/permissions>.

## 2. Delete local data

```sh
gmail uncache        # clear the local message cache and history marker
```

To remove everything — configuration, local database, action history, and
diagnostic logs — delete the application data directory:

- macOS: `~/Library/Application Support/gmail-agent-cli/`
- Windows: `%APPDATA%\gmail-agent-cli\`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/gmail-agent-cli/`

Then uninstall the package:

```sh
npm uninstall --global gmail-agent-cli
```

## 3. What {{PUBLISHER_LEGAL_NAME}} holds, and how to remove it

If you used **Included GPT**, our gateway holds one kind of record: a
pseudonymous identifier (an HMAC hash of your Google account's stable subject
ID — not your email address, name, or any message content) with request
timestamps, used to enforce fair-use limits. These expire automatically within
7 days.

To request earlier deletion, email {{PRIVACY_EMAIL}} from the Google account
you used. We will confirm the account and delete the matching rows, normally
within 30 days.

We hold no copies of your email. Message content is never stored by the gateway
or by us — it is forwarded to OpenAI for the single request and discarded.

## 4. OpenAI

Requests are sent with storage disabled (`store: false`), so they are not
retained as OpenAI application state. OpenAI's own abuse-monitoring retention
may apply for a limited period under their data policies. If you used your own
OpenAI API key, manage that data in your own OpenAI account.

## 5. What we cannot do

We cannot restore mail you permanently deleted in Gmail, and we cannot recall
an unsubscribe request that was already sent. Mail this app moved to Trash is
recoverable in Gmail until Gmail's own Trash retention expires.

Questions: {{PRIVACY_EMAIL}}.
