# Gmail Agent CLI

Clean up Gmail, browse your inbox in the terminal, and compose messages from the command line. The executable is `gmail`.

**[Documentation](docs/README.md)** · [All commands and keyboard shortcuts](docs/commands.md) · [Production release](docs/production.md) · [Development](docs/development.md)

Mailbox access and automation run on your own computer. `gmail ui` opens a small local browser page for setup, the command reference, and status. A publisher-built release includes Google sign-in, so setup is just **Connect Gmail** and Google's consent screen. It also includes publisher-funded, server-side GPT access for classification and writing with no user API key or local AI installation. Developers can still test directly with their own OpenAI key.

## What it does

- Scans Inbox and Spam, applies local spam/important rules, and optionally uses AI to classify unresolved mail.
- Moves eligible mail to Trash, stars and labels important messages, archives read Inbox mail, and can create private Calendar events from actionable messages.
- Keeps a local cache for incremental scans and terminal browsing.
- Supports reading, searching, composing, replying, and AI drafts in `gmail view`.
- Offers the same setup, command reference, and status as three plain pages served on `127.0.0.1` by `gmail ui`.

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

### 2. Connect Gmail

A publisher-built release needs no Google Cloud setup, credentials file, or API key from the user. Run `gmail ui` and press **Connect Gmail**.

When running directly from a source checkout, use a separate development OAuth project:

1. Create or select a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Gmail API** and **Google Calendar API**.
3. Configure the Google Auth platform consent screen with the app name and contact details. For personal Gmail, select an external audience and add your Gmail address as a test user while the app is in Testing.
4. Configure the requested scopes: `openid`, `email`, `https://www.googleapis.com/auth/gmail.modify`, and `https://www.googleapis.com/auth/calendar.events.owned`.
5. Under **Clients**, create an OAuth client with application type **Desktop app**. Obtain the client ID and client secret. This is an OAuth client, not an API key; the app handles its local browser callback.

See Google's [desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [Gmail scope documentation](https://developers.google.com/workspace/gmail/api/auth/scopes). External apps in Testing using Gmail scopes have refresh tokens that expire after seven days; public distribution needs the applicable verification process. [Token expiration documentation](https://developers.google.com/identity/protocols/oauth2#expiration)

Set these variables in the terminal running the CLI. Example syntax for macOS/Linux shells:

```sh
export GMAIL_AGENT_OAUTH_CLIENT_ID="your-desktop-client-id"
export GMAIL_AGENT_OAUTH_CLIENT_SECRET="your-desktop-client-secret"
```

Both variables are needed on subsequent authenticated development runs too. Keep real credentials outside the repository, in a private environment or secret manager. The app does **not** automatically load `.env` files. Publishers should follow the separate [production release guide](docs/production.md); its build command embeds the verified Desktop client only in the generated release artifact and refuses to publish an unconfigured build.

### 3. Sign in and preview

Either open the local setup page:

```sh
gmail ui
```

…and press **Connect Gmail**, then **Preview cleanup**; or do the same in the terminal:

```sh
gmail setup            # connect, choose how AI works, or disconnect
gmail --dry-run --limit 25
```

On first use, the CLI prompts to open Google sign-in in your browser, asks you to confirm your timezone, and then asks how you want AI to work. It stores the refresh token in the OS credential store. Complete this in an interactive terminal (or in the `gmail ui` page). Only one signed-in Gmail account is supported at a time.

**Signing in never starts a cleanup.** Connecting an account and changing your mailbox are always separate, explicit actions.

The preview reads mail but does not change Gmail or Calendar. Initial setup still saves local account state, and an enabled AI provider can make AI calls. On a full scan, the limit applies separately to Inbox and Spam: this can select up to 50 messages, plus auxiliary reads.

To browse without running cleanup:

```sh
gmail cache --limit 25
gmail view --previous
```

`cache` reads Gmail and saves local state without AI or mailbox changes. `--previous` skips the view's initial refresh; it is not an offline mode. Opening a message fetches content and marks it read. A capped cache may be incomplete.

### 4. Choose how AI works

`gmail setup` (or the Setup page in `gmail ui`) offers three options and shows what each one costs before you pick it:

| Option | What it needs | Where your mail is processed |
| --- | --- | --- |
| **Included GPT (no API key)** | A publisher release with its AI service enabled. No OpenAI account, key, model download, or extra software. Usage limits may apply. | Selected message text goes through the publisher-operated gateway to OpenAI. Gmail tokens and attachments do not. |
| Your own OpenAI API key (advanced development) | An OpenAI account and key you create and pay for per use. | Selected message text (never attachments) goes directly to the OpenAI API. |
| No AI — rules only | Nothing. | Nowhere. |

Included GPT is the normal production path. The publisher keeps its OpenAI key on the server; users never receive it and do not install or run a local model. Choosing Included GPT still asks for explicit consent before selected message text is sent off the device.

Rules-only mode is a real mode, not a preview: native-spam cleanup, your own rules, and archiving read mail all still work without any AI. Manual reading, composing, and replying never need AI.

`aiEnabled` in `config.json` is a genuine off switch — with it off, no classification or drafting call is made even if a hosted provider is configured. A schema-v2 local-model configuration is migrated to Included GPT on first read and its incompatible local URL/model values are removed.

Classification uses the saved `model`; drafting uses `composeModel`. `GMAIL_AGENT_MODEL` and `GMAIL_AGENT_COMPOSE_MODEL` override them on each run. For headless automation, `OPENAI_API_KEY` is still read from the environment when no key is stored in the credential store. Advanced users can point `aiProvider`/`aiBaseUrl` at an `openai-compatible` Responses API endpoint; see [configuration details](docs/development.md#configuration).

To test against real GPT models from a source checkout, set `OPENAI_API_KEY`, leave `GMAIL_AGENT_MODEL` / `GMAIL_AGENT_COMPOSE_MODEL` at their defaults (or set another enabled GPT model), and choose **Your own OpenAI API key** in setup. This direct developer path does not depend on the publisher gateway.

Hosted AI sends selected email text to the provider. Drafting can use recent Sent mail to build a saved writing-style description (only the description is stored, never the sampled mail). Calls use `store: false`, which is not a promise of zero provider retention — review the provider's data handling before choosing that option.

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
| `gmail setup` | Connect, reconnect, disconnect, or change how AI works. Touches no mail. |
| `gmail ui [--port N] [--no-open]` | Open the local Setup / Commands / Status pages in a browser. |
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
| No OAuth client configured | Use a publisher-built release, or set both `GMAIL_AGENT_OAUTH_CLIENT_*` variables for a source checkout. |
| Google rejects sign-in | Check the Desktop client, enabled APIs, test-user address, and Workspace administrator restrictions. |
| Sign-in expires after a week | Check the OAuth app's Testing status and token expiration. |
| Expired or revoked authorization | Run `gmail setup` and choose **Reconnect Gmail**, or press Connect on the `gmail ui` Setup page. The unusable token is erased automatically the next time it is found to be dead, and a normal run offers to sign in again. |
| Credential store unavailable | Install/rebuild `keytar` if needed and unlock/start the OS credential service. There is no plaintext fallback. |
| AI unavailable | Run `gmail setup`: it reports whether Included GPT can authenticate to the publisher service or whether a development key is usable. Rules-only cleanup can still change mail. |
| Browser page will not load | The `gmail ui` URL only works while that command is running, and only from this computer. Restart it to get a fresh link. |
| Gmail quota exceeded | Let the queue back off; extra keys in one project do not add quota. See [performance notes](docs/development.md#gmail-performance). |
| Cache looks stale | Refresh with `u` in the view or `gmail cache`. `gmail uncache` forces a rebuild on the next scan. |

See the [development guide](docs/development.md) for configuration, performance, project structure, and validation. Licensed under [MIT](LICENSE).
