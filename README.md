# Gmail Agent CLI

Clean up Gmail, browse your inbox in the terminal, and compose messages from the command line. The executable is `gmail`.

**[Documentation](docs/README.md)** · [All commands and keyboard shortcuts](docs/commands.md) · [Development](docs/development.md)

This is currently a local CLI. A minimal browser front-end for setup and documentation is planned; it is not built or hosted yet. Use the documentation above until it launches. The current development build requires a Google OAuth client. AI is optional and currently requires a provider API key; sign-in-only AI is a planned improvement.

## What it does

- Scans Inbox and Spam, applies local spam/important rules, and optionally uses AI to classify unresolved mail.
- Moves eligible mail to Trash, stars and labels important messages, archives read Inbox mail, and can create private Calendar events from actionable messages.
- Keeps a local cache for incremental scans and terminal browsing.
- Supports reading, searching, composing, replying, and AI drafts in `gmail view`.

**Bare `gmail` makes mailbox changes.** Start with `gmail --dry-run` to preview cleanup. Trash is reversible through Gmail; the app does not permanently delete messages. Sending mail requires confirmation showing the exact message. Opening mail in `gmail view` marks it read.

## Setup

### 1. Install and build

Use Node.js **22.19 or newer** (Node 24 is a suitable choice), Git, and pnpm. You also need an OS credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service. Native SQLite and credential modules may require platform build tools. On Linux, building the credential module requires the libsecret development package.

```sh
git clone https://github.com/wumich15/gmail-agent-cli.git
cd gmail-agent-cli
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --help
```

To make `gmail` available in your terminal:

```sh
pnpm link --global
gmail --help
```

If pnpm reports a missing global bin directory, run `pnpm setup`, reopen your terminal, and retry the link. You can also use `node dist/cli.js` in place of `gmail` in every example below. Rebuild after changing source code.

### 2. Configure Google access

These steps are for this development build. The planned public release will use a publisher-managed OAuth client so users can connect without visiting a developer console.

1. Create or select a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Gmail API** and **Google Calendar API**.
3. Configure the Google Auth platform consent screen with the app name and contact details. For personal Gmail, select an external audience and add your Gmail address as a test user while the app is in Testing.
4. Configure the requested scopes: `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/calendar.events.owned`.
5. Under **Clients**, create an OAuth client with application type **Desktop app**. Obtain the client ID and client secret. This is an OAuth client, not an API key; the app handles its local browser callback.

See Google's [desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [Gmail scope documentation](https://developers.google.com/workspace/gmail/api/auth/scopes). External apps in Testing using Gmail scopes have refresh tokens that expire after seven days; public distribution needs the applicable verification process. [Token expiration documentation](https://developers.google.com/identity/protocols/oauth2#expiration)

Set these variables in the terminal running the CLI. Example syntax for macOS/Linux shells:

```sh
export GMAIL_AGENT_OAUTH_CLIENT_ID="your-desktop-client-id"
export GMAIL_AGENT_OAUTH_CLIENT_SECRET="your-desktop-client-secret"
```

Both variables are needed on subsequent authenticated runs too. Keep real credentials outside the repository, in a private environment or secret manager. The app does **not** automatically load `.env` files.

### 3. Sign in and preview

```sh
gmail --dry-run --limit 25
```

On first use, the CLI prompts to open Google sign-in in your browser and asks you to confirm your timezone. It stores the refresh token in the OS credential store. Complete this in an interactive terminal. Only one signed-in Gmail account is supported at a time.

The preview reads mail but does not change Gmail or Calendar. Initial setup still saves local account state, and a configured AI key can cause AI calls. On a full scan, the limit applies separately to Inbox and Spam: this can select up to 50 messages, plus auxiliary reads.

To browse without running cleanup:

```sh
gmail cache --limit 25
gmail view --previous
```

`cache` reads Gmail and saves local state without AI or mailbox changes. `--previous` skips the view's initial refresh; it is not an offline mode. Opening a message fetches content and marks it read. A capped cache may be incomplete.

### 4. Optionally enable AI

Without an AI key, the CLI uses rules-only mode. Manual reading, composing, and replying do not need an AI key. Cleanup can still apply deterministic rules, handle native Spam, and archive read mail.

For AI classification and drafting, make `OPENAI_API_KEY` available through your private environment. The resolver checks the account's OS credential store first, then this variable. A usable key enables AI; the legacy `aiEnabled` field does not control activation in this build.

Classification uses the saved `model`; drafting uses `composeModel`. `GMAIL_AGENT_MODEL` and `GMAIL_AGENT_COMPOSE_MODEL` override them on each run. Choose models available to your provider account; the source defaults are not a guarantee of access.

Advanced users can configure an `openai-compatible` endpoint through `aiProvider` and `aiBaseUrl` in `config.json`. It must support the Responses API and this app's structured outputs. The current resolver still requires a nonempty key. See [configuration details](docs/development.md#configuration).

AI features send selected email text to the configured provider. Drafting can use recent Sent mail to build a saved writing-style description. Review the provider's data handling before enabling it. Calls use `store: false`, which does not promise zero provider retention.

### 5. Run cleanup when ready

```sh
gmail --limit 25
```

Review the result before increasing the limit. `gmail` without a limit has no explicit message cap. Root `--dry-run` and `--json` do not provide a general preview/output mode for other commands.

## Command quick reference

| Command | Purpose |
| --- | --- |
| `gmail [--dry-run] [--json] [--limit N]` | Preview or run cleanup. |
| `gmail add spam "Category"` | Create a spam rule and act on current matches after confirmation. |
| `gmail add important "Category"` | Create an important rule and act on current matches after confirmation. |
| `gmail category "Shopping" "Travel"` | Create Gmail labels immediately. |
| `gmail cache [--limit N]` | Cache Inbox and Spam without AI or mailbox changes. |
| `gmail uncache [--yes]` | Clear local scan cache and sync marker. |
| `gmail view [--limit N] [--previous]` | Browse, read, compose, and reply. |
| `gmail send [to] [--subject TEXT] [--ai]` | Compose one email and confirm before sending. |
| `gmail help [command]` | Show all help or help for one command. |

```sh
gmail help add
gmail view --help
gmail send "someone@example.com" --subject "Following up"
```

The [complete reference](docs/commands.md) documents every option, confirmation, side effect, and keyboard shortcut. `gmail work`, `gmail auth`, `gmail config`, `gmail doctor`, `gmail rules`, `gmail summary`, and `gmail undo` are not exposed commands in this build, even though underlying modules exist.

## Local data and troubleshooting

Configuration, SQLite state, and diagnostic logs live in:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/gmail-agent-cli/` |
| Windows | `%APPDATA%\gmail-agent-cli\` |
| Linux | `$XDG_CONFIG_HOME/gmail-agent-cli/`, or `~/.config/gmail-agent-cli/` |

Tokens and stored AI keys use the OS credential store. SQLite contains mailbox metadata, assessments, rules, and action history; message snippets and full message/attachment bodies are not the persistent cache. Treat the data directory as private. `gmail uncache` clears scan state, not credentials or all history.

| Problem | What to check |
| --- | --- |
| `gmail` is not found | Reopen the terminal after pnpm setup/linking, or run `node dist/cli.js`. |
| No OAuth client configured | Set both `GMAIL_AGENT_OAUTH_CLIENT_*` variables in this terminal. |
| Google rejects sign-in | Check the Desktop client, enabled APIs, test-user address, and Workspace administrator restrictions. |
| Sign-in expires after a week | Check the OAuth app's Testing status and token expiration. |
| Expired or revoked authorization | No reconnect command is exposed yet. Quit the CLI, remove this account's `oauth-refresh-token:` credential under `gmail-agent-cli` using your OS credential manager, then rerun `gmail --dry-run --limit 25` to sign in. Keep the data directory to retain rules/history. |
| Credential store unavailable | Install/rebuild `keytar` if needed and unlock/start the OS credential service. There is no plaintext fallback. |
| AI unavailable | Check the key, model access, endpoint compatibility, and provider quota. Rules-only cleanup can still change mail. |
| Gmail quota exceeded | Let the queue back off; extra keys in one project do not add quota. See [performance notes](docs/development.md#gmail-performance). |
| Cache looks stale | Refresh with `u` in the view or `gmail cache`. `gmail uncache` forces a rebuild on the next scan. |

See the [development guide](docs/development.md) for configuration, performance, project structure, and validation. Licensed under [MIT](LICENSE).
