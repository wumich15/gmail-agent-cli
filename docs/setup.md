# Setup: connecting the tool to your own Google account

This tool runs on your computer, against your own Gmail account, with a Google
app you register yourself — so you connect it to Google once, and nobody else's
credentials are ever in the path.

**The short version:** install the tool and run `gmail install`. It walks these
same steps interactively, opening each Google page for you and collecting what
it needs, and finishes with a preview that changes nothing. This page is the
written form of that wizard — useful if you would rather see every field named
first, or if something went wrong.

Budget about ten minutes. You do this once per computer.

## Why you have to do this at all

Google requires an app to identify itself before it can touch a mailbox, and
this build ships no shared identity. So **you** register the app, which means
your mail is only ever reachable with your own credentials, and your API usage
is your own.

The values you create below are not passwords, and they give nobody access to
anything on their own. Access comes from the Google sign-in you complete
afterwards, in your own browser, and you can revoke it at any time at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## 1. Create a Google Cloud project

1. Open [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate).
2. Give it any name — `my-gmail-agent` is fine — and click **Create**.
3. Make sure the new project is selected in the picker at the top of the page.

A Cloud project is free. This one will only ever be used by you, on this
computer.

## 2. Enable the two APIs it uses

In that project, enable both:

- [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) → **Enable**
- [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) → **Enable**

## 3. Configure the consent screen

Go to **APIs & Services → OAuth consent screen** (newer consoles call this
**Google Auth Platform → Branding**).

1. **User type: External.** ("Internal" only exists for Google Workspace
   organizations; pick it if you have one and want this limited to your org.)
2. App name: anything you'll recognize. User support email and developer
   contact email: your own address.
3. **Scopes** — add exactly these two:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar.events.owned`
4. **Test users** — add your own Gmail address.

Note the tradeoff on publishing status, because it decides how often you
re-authorize:

| Status | What happens |
| --- | --- |
| **Testing** (default) | Works immediately for the test users you list. Google expires the sign-in every **7 days** for Gmail scopes, so you re-run `gmail setup` weekly. |
| **In production** (unverified) | You click through an "unverified app" warning once. The sign-in then **persists**, which is what most people want. Your app stays unverified and private — verification only matters if you distribute it to other people. |

If the weekly re-authorization annoys you, press **Publish app** and accept the
unverified warning. You are the only user.

## 4. Create the Desktop OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**

- Application type: **Desktop app**
- Name: anything

Google shows you a **client ID** (ending in `.apps.googleusercontent.com`) and a
**client secret**. Keep that dialog open for the next step.

## 5. Give them to the tool

Either in the terminal:

```sh
gmail install    # the guided wizard, or:
gmail setup      # the same prompts, from the settings menu
```

…which asks for the client ID and secret, then opens Google sign-in. Or in the
browser page:

```sh
gmail ui
```

…which shows the same form and a **Connect Gmail** button.

They are saved to your own application data directory with owner-only
permissions:

- macOS: `~/Library/Application Support/gmail-agent-cli/google-oauth-client.json`
- Windows: `%APPDATA%\gmail-agent-cli\google-oauth-client.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/gmail-agent-cli/google-oauth-client.json`

The Google **refresh token** from signing in never goes in that file — it goes
to your OS credential store (macOS Keychain, Windows Credential Manager, Linux
Secret Service).

Prefer environment variables instead of the saved file? Set
`GMAIL_AGENT_OAUTH_CLIENT_ID` and `GMAIL_AGENT_OAUTH_CLIENT_SECRET`; they take
precedence whenever they're set.

## 6. Choose how AI works

`gmail setup` asks next. Two options, both local to you:

**Your own OpenAI API key.** Create one at
[platform.openai.com/api-keys](https://platform.openai.com/api-keys), add a
little credit, and paste it when asked. It is stored in your OS credential
store and used to call OpenAI directly from your machine. Triage costs a
fraction of a cent per message; a busy inbox is cents per run.

**No AI — rules only.** Nothing is sent anywhere. Gmail's own spam handling,
your `gmail spam`/`gmail important` rules, and archiving of read mail all still
work; anything needing judgment is simply left alone.

You can change this later with `gmail setup` at any time. To use a
non-OpenAI endpoint that implements the same Responses API, set
`GMAIL_AGENT_AI_PROVIDER=openai-compatible` and `GMAIL_AGENT_AI_BASE_URL=...`.

Every option that sends message text anywhere asks for explicit consent first
and names where it goes.

(There is a third provider in the code — a publisher-funded hosted service —
but it only appears in a build that embeds publisher configuration. This one
does not, so `gmail setup` does not list it. See
[docs/production.md](production.md) if you ever want to run that service
yourself.)

## 7. Preview before anything changes

```sh
gmail --dry-run --limit 25
```

This reads mail and prints what it *would* do. Nothing in Gmail or Calendar
changes. When the plan looks right:

```sh
gmail
```

Nothing is ever permanently deleted — anything it removes goes to Gmail's own
Trash, where you can restore it — and no email is ever sent without you
confirming that exact message first.

## Troubleshooting

**"This computer isn't set up yet"** — step 5 hasn't happened, or the saved
file was deleted. Run `gmail install`.

**"Access blocked: this app's request is invalid"** — the consent screen is
missing one of the two scopes, or the client is not of type *Desktop app*.

**"Gmail API has not been used in project … before or it is disabled"** — step 2
was skipped for one of the two APIs.

**Sign-in stops working every week** — your consent screen is in *Testing*. See
the table in step 3.

**"Credential store unavailable"** — the OS keychain could not be reached.
On Linux install `libsecret` and make sure a Secret Service (GNOME Keyring,
KWallet) is running and unlocked. There is deliberately no plaintext fallback.

**Anything else** — run `gmail setup`. It reports the current connection, which
Google app is in use, and whether AI is actually usable right now, without
touching any mail.
