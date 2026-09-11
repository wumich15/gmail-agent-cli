# Gmail command reference

This reference describes the commands currently registered in `src/cli.ts`. For installation, Google sign-in, and optional AI configuration, see the [setup instructions](../README.md).

## Quick reference

| Command | What it does |
| --- | --- |
| `gmail --dry-run` | Preview inbox cleanup without changing Gmail or Calendar. |
| `gmail` | Run cleanup and apply the resulting Gmail and Calendar actions. |
| `gmail add spam "query"` | Create a persistent spam rule and move current matches to Trash after confirmation. |
| `gmail add important "query"` | Create a persistent important rule and star/mark current matches after confirmation. |
| `gmail category "name"` | Create or reuse a Gmail label immediately. |
| `gmail cache` | Read Inbox and Spam into the local listing/scan cache. |
| `gmail uncache` | Clear the local scan cache after confirmation. |
| `gmail view` | Browse messages, read, compose, reply, and move messages to Trash in the terminal. |
| `gmail send` | Interactively compose and confirm one new email. |
| `gmail setup` | Connect or reconnect Gmail, choose how AI works, or disconnect. Touches no mail. |
| `gmail ui` | Open the same setup, command reference, and status in a local browser page. |
| `gmail help` | Show command help and inbox controls. |
| `gmail help <command>` | Show help for one command. |
| `gmail --version` | Print the installed CLI version. |

All commands support `-h` / `--help`. The version shortcut is `-V`.

`gmail`, `gmail cache`, `gmail view`, and `gmail send` start browser sign-in if needed. `add`, `category`, and `uncache` require an existing sign-in. One Google account is supported at a time. `gmail setup` and `gmail ui` are the places to connect, reconnect, disconnect, or change the AI setting deliberately, without any mailbox work happening as a side effect.

**Bare `gmail` applies changes without a separate approval prompt after the scan. Start with `gmail --dry-run` to review its behavior.** The root `--dry-run` and `--json` options apply to the bare cleanup command only; they do not make other commands read-only or change their output format.

## Cleanup: `gmail`

```sh
gmail --dry-run
gmail --dry-run --limit 100
gmail --dry-run --json
gmail --limit 100
gmail
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--dry-run` | Off | Scan and show proposed actions without applying Gmail or Calendar changes. |
| `--json` | Off | Print the final summary as JSON on standard output; status and diagnostics go to standard error. |
| `--limit <n>` | No cap | Limit messages selected for processing. Must be a positive whole number. |

On a full snapshot, `--limit 100` selects up to 100 Inbox messages **and** 100 native Spam messages. On an incremental scan, it caps the combined queue to 100 messages. It is not a maximum number of API calls. Auxiliary reads, retries, AI calls, and writes can add work. A truncated scan clears its history checkpoint so a later uncapped run can recover omitted mail.

Cleanup can:

- Move unprotected native Gmail Spam and matching spam-rule messages to Trash.
- Star and mark messages important when an applicable rule or AI assessment calls for it.
- Archive read Inbox messages that are not being trashed, including starred messages.
- With AI configured, classify mail, propose topical labels, and create validated future Calendar events. Mail selected for an event is also scheduled for a `Calendar` label and archiving, even if unread.
- Save automatic spam rules when at least three qualifying unread bulk-spam messages share a sender/list identity in one run.

New AI-generated topical labels require ten distinct message votes accumulated across runs. Labels that already exist can be reused without that creation threshold. `gmail category` creates labels directly.

Without an AI credential, cleanup runs in rules-only mode. That still permits native-spam cleanup, rule actions, and archiving read mail. It is not a preview mode. The CLI does not permanently delete messages or send email during cleanup.

Dry runs still read Gmail, consume API quota, and call the configured AI provider. First-time sign-in stores credentials and configuration, and normal local logging still occurs. Dry runs do not advance the cleanup checkpoint or save planned mailbox actions.

After a complete initial snapshot, later runs use Gmail history plus cached messages that need evaluation. An expired checkpoint triggers a full snapshot. A `gmail cache` snapshot can seed this process, but uncategorized cached messages still need a subsequent live cleanup assessment.

**Cache-first.** If the cache was refreshed within the last 15 minutes — by `gmail cache`, or by a `gmail view` session that has been refreshing itself, whichever happened later — and there is already queued work, the run skips the "what changed in Gmail?" check and works straight through that queue. It says so on stderr. Each queued message is still fetched live before it is classified, because bodies are never stored. The sync checkpoint is left where it was, so the next run still picks up anything that arrived in the meantime; nothing is skipped, only deferred.

The first cleanup on an account also builds a reply-protection index of the threads you have sent mail on, which requires paging your Sent mail once and can take a while on a large mailbox. It is saved locally, so later runs only look for newly sent messages.

For scripted JSON output, complete sign-in first: interactive first-run prompts are not a JSON interface.

## Rules: `gmail add`

```sh
gmail add spam "LinkedIn"
gmail add spam "LinkedIn" "Newsletter"
gmail add important "from:person@example.com"
gmail add important "School" --yes
```

Syntax: `gmail add <spam|important> [categories...]`

The category text is used as a Gmail search query to discover current senders or mailing lists. The saved rule matches those discovered identities; it does not simply save the original search expression. Quote a query or name containing spaces. Multiple quoted categories create independent rules.

| Option | Default | Meaning |
| --- | --- | --- |
| `--yes` | Off | Authorize rule creation **and its immediate actions on current matches** without the confirmation prompt. |

Although the syntax permits omitting categories, the interactive picker is not implemented. Supply at least one query.

### Spam rules

`gmail add spam` searches Inbox and native Spam, up to 500 matching messages per category. It groups matching senders/lists, shows the discoveries, and asks to create the rule and move current covered matches to Trash. An explicit spam request can override an overlapping important rule.

The command reports unsubscribe methods that need manual action. It currently does not perform automatic unsubscribe through this public command. An output suggestion to pass `--allow-mailto` is outdated: that option is not exposed by `gmail add`.

### Important rules

`gmail add important` searches Inbox only, up to 500 matches per category. A persistent rule requires a sender identity bound to currently passing, aligned DKIM/DMARC authentication. Identities without that binding are skipped; no suitable identity means no rule is created. An overlapping spam rule blocks creation.

After confirmation, current covered matches are starred and marked Important. This does not stop a later normal cleanup from archiving them once read.

Both rule types report truncated searches. A category with no usable matches creates no rule. There is currently no public CLI command for listing, editing, disabling, or deleting saved rules.

## Labels: `gmail category`

```sh
gmail category "Shopping"
gmail category "Shopping" "Travel"
```

Syntax: `gmail category <names...>`

Creates each named Gmail label immediately, with no confirmation prompt. Existing names are reused case-insensitively. This command only creates the label; it does not apply it to existing mail. Later AI-enabled cleanup can use it for matching messages.

There are no command-specific options. The command's current success text mentions a ten-message threshold for future reuse; existing labels actually bypass that threshold in the cleanup implementation.

## Guided setup: `gmail install`

```sh
gmail install
```

The first command to run after installing. It checks this machine, walks the
Google Cloud console steps (opening each page for you), collects your Desktop
OAuth client ID and secret, signs you in, asks how AI should work, and ends
with a dry run.

Every step detects what is already configured and offers to keep it, so it is
safe to re-run after an interruption — it never undoes working configuration.
The run it finishes with is always a dry run: completing setup must not be what
first changes your mailbox. Requires an interactive terminal, and exits with
code `3` if stdin is not a TTY.

## Snapshot: `gmail cache`

```sh
gmail cache
gmail cache --limit 100
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--limit <n>` | No cap | Cache up to the latest `n` Inbox messages and `n` native Spam messages. Must be a positive whole number. |

Always requests a full snapshot of the selected Inbox and Spam scope. It reads Gmail and writes local cache state, with no AI calls or Gmail/Calendar mutations. Archived mail, Trash, and Sent are outside this listing cache.

The cache stores message identifiers, subjects, sender display values, dates, labels, content hashes, and assessment metadata when available. It does not persist full message bodies or attachments. Reading a message in `gmail view` fetches its content from Gmail.

A complete successful snapshot establishes a history checkpoint for later incremental work. If the cap omits messages or reads fail, the checkpoint is cleared so a later full run can recover them. Repeatedly running `gmail cache` requests another full snapshot; use `gmail view` for normal incremental listing refreshes.

## Clear cache: `gmail uncache`

```sh
gmail uncache
gmail uncache --yes
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--yes` | Off | Skip the confirmation prompt. |

Clears this account's cached message projections, pending topical-label votes/counts, and Gmail history checkpoint. The next cleanup or snapshot must rebuild from Gmail. This does not change Gmail or Calendar, remove saved rules, sign out, or clear the saved writing-style profile.

## Terminal inbox: `gmail view`

```sh
gmail view
gmail view --limit 50
gmail view --previous
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--limit <n>` | `20` | Messages per page. This does **not** cap synchronization or API reads. Must be a positive whole number. |
| `--previous` | Off | Open the existing cache without a startup refresh. |

Requires an interactive terminal. Startup normally refreshes via Gmail history and falls back to a full `gmail cache` snapshot if no usable checkpoint exists. Inbox is the initial filter when any Inbox messages are cached. If the cache is empty, the command exits rather than opening a compose-only view; use `gmail send` to compose.

`--previous` skips the initial refresh; it is not an offline email reader. Opening messages, refreshing, sending, and deleting still use Gmail. Custom labels may appear as IDs until refreshed.

Opening an unread message marks it read in Gmail. The quick reply shortcuts also fetch and mark the original message read. A later `gmail` cleanup may archive that read mail.

### Message list controls

Type commands and press **Enter**, except for arrow keys and Escape, which act immediately. Arrow shortcuts operate when the command input is empty. Message numbers refer to rows on the current page.

| Input | Action |
| --- | --- |
| Up / Down | Move the highlighted row, wrapping within the page. |
| Enter on an empty prompt | Open the highlighted message. |
| `<n>` | Open message `n`, for example `2`. |
| `<n> r` | Start a manual reply to message `n`. |
| `<n> ;r` | Start an AI reply to message `n`. |
| `<n> d` | Confirm moving message `n` to Trash without fetching its body. |
| `d` | Confirm moving the highlighted message to Trash. |
| `dd` | Move the highlighted message to Trash **with no confirmation**, and stay in the list. The cursor keeps its row number, so it lands on the next message and repeating `dd` deletes down the list. |
| Left / Right | Previous / next page. |
| `p` / `n` | Previous / next page. |
| `[` / `]` | Back / forward through previous page, size, search, and filter views. |
| Escape | Return to the first page and default Inbox filter, clearing search. Keeps the page size and never quits. |
| `+` / `-` | Increase / decrease page size using 5, 10, 20, 50, and 100. Above 100, `+` doubles up to 500; below 5, `-` goes to 1. |
| `l <n>` | Set an exact page size, for example `l 30`; this can exceed the `+` shortcut's 500-message ceiling. |
| `f` (alias `t`) | Choose labels. Matching any selected label is sufficient; selecting none shows all cached Inbox/Spam mail. |
| `s <text>` | Search cached subjects and sender display text, case-insensitively. This is not Gmail query syntax or body search. |
| `s` | Clear the search. |
| `c` | Compose a new message manually. |
| `a` (alias `;c`) | Compose a new message with AI. |
| `;s` | Refresh the saved writing-style description using recent Sent mail and AI. |
| `;u` | Restore the last message moved to Trash during this session. One undo slot, cleared after restoring. |
| `u` | Refresh from Gmail and return to page one, keeping search/filter choices. |
| `q` | Quit. |
| Ctrl+C | Exit immediately. |

### While reading a message

These keys act without Enter.

| Key | Action |
| --- | --- |
| Escape | Return to the list. |
| Left / `p` | Previous message in the current filtered result set. |
| Right / `n` | Next message in the current filtered result set. |
| `r` | Compose a manual reply. |
| `;` followed by `r` within one second | Draft an AI reply. |
| `d` | Confirm moving this message to Trash and return to the list. |
| `l` | List full URLs found in the message. |
| `o` | Choose a message link to open in the system browser. |
| Ctrl+C | Exit immediately. |

Links are shortened for display and are clickable in terminals that support hyperlinks. Reading uses plain text extracted from the message, not a full HTML mail renderer.

**Delete means move to Gmail Trash, and its confirmation defaults to Yes.** A successful delete removes the row from the local list immediately. Use `;u` from the list to undo the most recent session delete, or restore messages through Gmail's Trash. The session undo does not reverse cleanup runs or earlier sessions.

`dd` performs the same Trash move with no question asked. It exists because deleting is reversible twice over — from Gmail's own Trash, and from `;u` for the most recent one this session — which is exactly what a send confirmation is not, and why no equivalent shortcut exists for sending. `;u` holds one message, so `dd` twice in a row leaves only the second recoverable in-session; both remain in Gmail's Trash.

## New email: `gmail send`

```sh
gmail send
gmail send "person@example.com" --subject "Checking in"
gmail send "one@example.com,two@example.com" --subject "Meeting follow-up" --ai
```

Syntax: `gmail send [to] [options]`

| Argument or option | Default | Meaning |
| --- | --- | --- |
| `[to]` | Prompt | One email address or comma-separated plain email addresses. |
| `--subject <text>` | Prompt | Prefill the subject. A blank subject becomes `(no subject)`. |
| `--ai` | Off | Select AI drafting directly. Without this flag, the command asks whether to compose manually or with AI. |

Requires an interactive terminal. There is no body flag, piped-send mode, attachment support, or CC/BCC option in this command. Recipient and subject are supplied by the user. Reply recipients in `gmail view` come from the original message's Reply-To address or sender; replies are not reply-all.

### Compose and reply workflow

1. Enter the recipient and subject where needed.
2. For a manual body, type plain text on multiple lines and finish with a single `.` on its own line. An empty body cancels.
3. For AI drafting, describe the new email's purpose or provide optional reply guidance. Review the result, then use it, replace the entire body, or discard it.
4. Review the exact final To, Subject, and body. **Sending requires an explicit confirmation, defaulting to No.** There is no flag that bypasses this step.

AI drafts are displayed locally for review; this workflow does not save a draft into Gmail's Drafts folder. On first use, AI writing-style support samples up to 12 recent Sent messages and saves a style description locally for later reuse. `;s` in the inbox list refreshes it. The source Sent bodies are not persisted in that profile, but sampled text is sent to the configured AI provider to derive it.

AI drafting requires the currently supported provider configuration and credential described in the [README](../README.md). When no AI credential is available, use manual composition/replies.

## Setup: `gmail setup`

```sh
gmail setup
```

Interactive, with no options. Shows the connected account and timezone, explains what each requested Google permission is used for, reports whether AI would actually work right now, and offers exactly one action at a time:

- **Connect / Reconnect Gmail** — runs the same browser sign-in as a first run. Use it after revoking access, changing the account password, or switching Google accounts. Connecting never starts a cleanup.
- **Change how AI works** — see below.
- **Disconnect** — revokes the grant with Google where possible and erases this computer's stored credentials. It then asks separately whether to keep local non-secret run and rule history; keeping it is the default.

Nothing in this command reads or changes mail.

### Choosing how AI works

Two options, each shown with its cost and requirements before it is selectable:

| Option | What it needs | Where mail is processed |
| --- | --- | --- |
| Your own OpenAI API key | An OpenAI account and key that you create and pay for per use. | Selected message text (never attachments) goes from this computer directly to the OpenAI API. |
| No AI — rules only | Nothing. | Nowhere. Native spam, your rules, and archiving of read mail still work. |

There is no hosted option: this tool has no server of its own, so nothing is processed by anyone but the provider you chose. The key is typed without being echoed and stored in the operating system's credential store — never in `config.json`, a log line, a command-line flag, or shell history.

## Browser interface: `gmail ui`

```sh
gmail ui
gmail ui --port 8123
gmail ui --no-open
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | OS-assigned | Listen on a specific port. Must be a positive whole number. |
| `--no-open` | Off | Print the URL instead of opening a browser. |

Serves three plain pages — **Setup**, **Commands**, **Status** — for as long as the command runs. Stopping the command (Ctrl+C) stops the server.

- The listener binds `127.0.0.1` only, so nothing on the network can reach it.
- The launch URL carries a session key generated fresh for each run. The page keeps it in memory and removes it from the address bar, and it stops working when the command exits.
- The command reference works without signing in. Account operations require the session key.
- No Google token and no AI key is ever sent to the browser. The page asks this local process to perform named operations; the process holds the credentials.
- **Preview** and **Run cleanup** are separate actions, and cleanup stays disabled until a preview has been produced. Finishing sign-in never starts a run.

Composing and sending mail is not exposed in the browser pages; that stays in `gmail view` and `gmail send`, where the exact-message confirmation lives.

## Help, output, and exit status

```sh
gmail help
gmail help add
gmail help cache
gmail help view
gmail help setup
gmail help ui
gmail send --help
gmail --version
```

| Exit code | Meaning |
| --- | --- |
| `0` | Command completed, or an interactive workflow ended without a propagated error. |
| `1` | Operational failure or a parser-rejected option/argument. |
| `2` | Application-level invalid input, missing authentication, or configuration error. |
| `3` | Safety precondition, rule conflict, declined rule/cache-clear confirmation, or missing terminal for `view`/`send`. |
| `130` | Ctrl+C in the terminal inbox. |

`gmail send` currently returns `0` even when a compose flow is cancelled or a send failure is caught and displayed. Check its `Sent.` / `Not sent.` / error message; exit zero alone does not prove delivery. Interactive inbox actions also display individual errors without necessarily making the eventual session exit fail.

The following names have implementations or historical documentation but are **not registered public commands**: `gmail work`, `gmail auth`, `gmail config`, `gmail doctor`, `gmail rules`, `gmail summary`, `gmail undo`, `gmail spam`, and `gmail important`. Use bare `gmail`, `gmail add spam`, and `gmail add important` as documented above. Account switching, disconnecting, and reconnecting are available through `gmail setup` and the `gmail ui` Setup page. There is still no public command for general action undo or rule management.
