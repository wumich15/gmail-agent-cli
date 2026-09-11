# Gmail Agent CLI

A terminal tool that cleans up your Gmail: trashes the junk, stars what needs you, turns real appointments into calendar events, and archives what you have already read. The executable is `gmail`.

```sh
gmail --dry-run   # see what it would do
gmail             # do it
```

Everything runs on your own computer. There is no server, no hosted account, and no service in the middle: you connect the tool to your own Google project and your own AI provider key, and your mail never passes through anyone else's infrastructure.

**[gmail-agent-cli](https://wumich15.github.io/gmail-agent-cli/)** · [Documentation](docs/README.md) · [Setup walkthrough](docs/setup.md) · [All commands and keyboard shortcuts](docs/commands.md) · [Development](docs/development.md)

## What it does

- Moves promotions, newsletters and native Gmail spam to **Trash** — you can always pull them back.
- Stars and marks important the mail that asks you something, names a deadline, or concerns money, security, travel or an appointment.
- Adds private Calendar events from mail with a real, explicit date. No guests, no invitations, no duplicates.
- Archives everything you have already read.
- Leaves anything uncertain alone, and lists it under Review.
- Creates persistent spam/important rules you name (`gmail add`) and applies them before any AI runs.
- `gmail view` is also a terminal mail client: read, search, delete, compose and reply, with AI drafts you edit before they go anywhere.
- `gmail ui` serves the same setup, command reference, and status as three plain pages on `127.0.0.1`, for as long as that command runs.

## What it never does

- **Never permanently deletes mail.** Everything it removes goes to Gmail's own Trash. The permanent-delete endpoints are not called anywhere in the code.
- **Never sends an email without showing you the exact message and asking.** Every outbound path — manual, AI-drafted, reply, unsubscribe — ends at the same confirmation, which defaults to *no*. There is no flag or keystroke that skips it.
- **Never follows instructions found inside an email.** Message text is evidence, never a command; the model gets no tools, no network and no credentials.
- **Never uploads attachments** — it does not even download them.
- **Never runs in the background** or keeps a copy of your mailbox on a server. Work happens only when you run a command.

**Bare `gmail` makes mailbox changes.** Start with `gmail --dry-run` to preview cleanup. Opening mail in `gmail view` marks it read.

## Where your mail goes

Nowhere, unless you turn on AI. The tool talks to Google with an OAuth app you registered yourself, and — only if you choose it — to OpenAI with your own API key. Nothing is relayed through anyone else, because there is no one else.

- **Your sign-in** lives in your OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service), never in a config file or log.
- **Message bodies are never written to disk.** The local SQLite cache holds IDs, labels, dates, senders, content hashes and an action ledger; reading a message fetches it live.
- **With AI on**, the sender, subject, date and a bounded plain-text excerpt of the message being classified are sent to OpenAI with `store: false`. Never attachments, never your Gmail tokens.
- **Rules-only mode is a real mode**, not a preview: Gmail's own spam handling, your rules, and archiving read mail all work with nothing leaving your computer.

## What it costs

Free and MIT licensed, with no account and no telemetry. Rules-only mode costs nothing at all. With your own OpenAI key you pay OpenAI directly — one small classification call per unresolved message, cached by content hash so the same mail is not re-read, which works out to cents per run.

## Setup

**New here: install, then run `gmail install`.** It is a guided wizard — it checks this machine, opens each Google Cloud page for you, collects the credentials, signs you in, asks how AI should work, and finishes with a preview that changes nothing. About ten minutes, once per computer. The steps below are the same thing written out, for anyone who would rather see every field named first.

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

Then, for the guided path, run `gmail install` and skip to step 5. Everything between is what that wizard does for you.

### 2. Connect it to your own Google project

Google requires an app to identify itself before it can touch a mailbox, and this tool ships no shared identity on purpose — a shared one would put whoever registered it in the path of everyone else's mail and API quota. So you register a Google app of your own, once:

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/projectcreate) (any name).
2. Enable the **Gmail API** and the **Google Calendar API** in it.
3. On the **OAuth consent screen**, choose **External**, add your own Gmail address as a test user, and add exactly two scopes: `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/calendar.events.owned`.
4. Under **Credentials**, create an **OAuth client ID** of type **Desktop app**.
5. Run `gmail install` (or `gmail setup`, or `gmail ui`) and paste the client ID and client secret.

They are saved on this computer only, with owner-only permissions; the refresh token from signing in goes to your OS credential store. `GMAIL_AGENT_OAUTH_CLIENT_ID` / `GMAIL_AGENT_OAUTH_CLIENT_SECRET` override the saved file when set.

While the consent screen is in **Testing**, Google expires the sign-in every 7 days for Gmail scopes. Pressing **Publish app** (and clicking past the one-time "unverified app" warning) makes it persist. You are the only user either way — verification only matters if you hand the app to other people.

The [setup walkthrough](docs/setup.md) has the same steps with every field named, plus troubleshooting.

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

`gmail setup` (or the Setup page in `gmail ui`) offers two options and shows what each one costs before you pick it:

| Option | What it needs | Where your mail is processed |
| --- | --- | --- |
| **Your own OpenAI API key** | An OpenAI account and a key you create at [platform.openai.com](https://platform.openai.com/api-keys). You pay per use — triage is a fraction of a cent per message. | Selected message text (never attachments) goes from this computer directly to the OpenAI API, under your account. |
| **No AI — rules only** | Nothing. | Nowhere. |

Choosing the key option asks for explicit consent before any message text leaves the device, and stores the key in your OS credential store — never in `config.json`, a log, or a shell command.

Rules-only mode is a real mode, not a preview: native-spam cleanup, your own rules, and archiving read mail all still work without any AI. Manual reading, composing, and replying never need AI.

`aiEnabled` in `config.json` is a genuine off switch — with it off, no classification or drafting call is made even if a key is present. Configurations left behind by earlier versions that offered a local model runtime or a hosted gateway are migrated to the direct-OpenAI provider with AI switched off, so setup asks before anything starts billing your account.

Classification uses the saved `model`; drafting uses `composeModel`. `GMAIL_AGENT_MODEL` and `GMAIL_AGENT_COMPOSE_MODEL` override them on each run. For headless automation, `OPENAI_API_KEY` is read from the environment when no key is stored in the credential store. To use any other endpoint implementing the same Responses API — including a model you run yourself — set `aiProvider`/`aiBaseUrl` to `openai-compatible`; see [configuration details](docs/development.md#configuration).

Sending mail text to OpenAI is still sending it to a third party. Calls use `store: false`, which is not a promise of zero provider retention — review OpenAI's data handling before choosing that option. Drafting can use recent Sent mail to build a saved writing-style description (only the description is stored, never the sampled mail).

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
| `gmail install` | Guided first-time setup: your own Google app, sign-in, AI choice, and a preview. Touches no mail. |
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
| No OAuth client configured | Run `gmail setup` and paste your Desktop OAuth client, or set both `GMAIL_AGENT_OAUTH_CLIENT_*` variables. See [setup](docs/setup.md). |
| Google rejects sign-in | Check the Desktop client, enabled APIs, test-user address, and Workspace administrator restrictions. |
| Sign-in expires after a week | Check the OAuth app's Testing status and token expiration. |
| Expired or revoked authorization | Run `gmail setup` and choose **Reconnect Gmail**, or press Connect on the `gmail ui` Setup page. The unusable token is erased automatically the next time it is found to be dead, and a normal run offers to sign in again. |
| Credential store unavailable | Install/rebuild `keytar` if needed and unlock/start the OS credential service. There is no plaintext fallback. |
| AI unavailable | Run `gmail setup`: it reports whether your stored API key is usable. Rules-only cleanup can still change mail. |
| Browser page will not load | The `gmail ui` URL only works while that command is running, and only from this computer. Restart it to get a fresh link. |
| Gmail quota exceeded | Let the queue back off; extra keys in one project do not add quota. See [performance notes](docs/development.md#gmail-performance). |
| Cache looks stale | Refresh with `u` in the view or `gmail cache`. `gmail uncache` forces a rebuild on the next scan. |

See the [development guide](docs/development.md) for configuration, performance, project structure, and validation. Licensed under [MIT](LICENSE).
