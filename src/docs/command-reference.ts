/**
 * The single source of truth for user-facing command documentation.
 *
 * `gmail help`, `gmail help <command>`, and the browser Commands view all
 * render this same data, so a command cannot change in one place and stay
 * stale in the other two. Only commands actually wired into `src/cli.ts`
 * belong here: several older modules still exist under `src/commands/` but
 * are not registered, and documenting an unreachable command is worse than
 * documenting nothing.
 */

export interface CommandOptionDoc {
  flag: string;
  description: string;
}

export interface CommandDoc {
  name: string;
  synopsis: string;
  summary: string;
  /** Longer prose. Plain text; rendered as paragraphs. */
  details: string;
  options: readonly CommandOptionDoc[];
  examples: readonly string[];
  /** Exactly what this command changes outside the local machine. "Nothing." when it is read-only. */
  sideEffects: string;
  /** What the user is asked before anything irreversible or outbound happens. */
  confirmation: string;
}

export interface ViewControlDoc {
  keys: string;
  description: string;
  /** Where the control applies, so the reference can be grouped rather than one flat list. */
  context: "list" | "read" | "both";
}

export const COMMANDS: readonly CommandDoc[] = [
  {
    name: "gmail",
    synopsis: "gmail [--dry-run] [--json] [--limit N]",
    summary: "Clean up the inbox: trash bulk mail, star what matters, and add Calendar events.",
    details:
      "Runs the full pipeline. On the very first run it signs you in first. Native Gmail spam and your " +
      "own rules are applied without any AI call; everything still unresolved is classified one message " +
      "at a time, and only high-confidence results act. Anything uncertain is listed under Review and " +
      "left alone. Read mail is left in the Inbox unless you pass --archive. Every change is recorded so " +
      "it can be listed and undone.",
    options: [
      { flag: "--dry-run", description: "Show what would happen and change nothing at all." },
      { flag: "--json", description: "Print one JSON summary to stdout instead of human text." },
      { flag: "--archive", description: "Also take read mail out of the Inbox. Off by default." },
      { flag: "--limit N", description: "Scan only the N most recent Inbox and Spam messages each, to bound API usage." }
    ],
    examples: ["gmail --dry-run", "gmail", "gmail --archive", "gmail --limit 200 --json"],
    sideEffects:
      "Moves mail to Trash (never permanent deletion), adds STARRED/IMPORTANT and topical labels, creates " +
      "Calendar events on your primary calendar, and may create local spam rules for repeated bulk senders. " +
      "Read mail stays in the Inbox unless --archive is passed. Sends no email.",
    confirmation: "The first normal run previews the changes and asks once before applying them. --dry-run never applies anything."
  },
  {
    name: "gmail add",
    synopsis: 'gmail add <spam|important> <category...> [--yes]',
    summary: "Create a persistent spam or important rule from a category you name.",
    details:
      "Resolves the category to concrete matchers — a mailing list's List-ID or an exact sender address, " +
      "never a whole domain without showing it and asking — and saves it as a rule that applies on every " +
      "later run. An important rule is additionally bound to the authentication result seen on the message " +
      "it was created from, so a lookalike sender cannot inherit your protection.",
    options: [{ flag: "--yes", description: "Authorize the narrow rule and its immediate current-message actions." }],
    examples: ['gmail add spam "LinkedIn"', 'gmail add important "Landlord" "School"'],
    sideEffects: "Saves a local rule and applies it to matching current mail (Trash for spam; star and mark important for important).",
    confirmation: "Shows every matcher it resolved and asks before saving, unless --yes is passed."
  },
  {
    name: "gmail category",
    synopsis: "gmail category <name...>",
    summary: "Create Gmail labels immediately, so the AI starts reusing them.",
    details:
      "Creates (or reuses, case-insensitively) real Gmail labels right now, with no message search and no " +
      "batch threshold. Automatic topical labeling only creates a label once at least ten messages in one " +
      "run agree on it; this command is how you seed a label you already know you want.",
    options: [],
    examples: ['gmail category "Receipts" "Travel"'],
    sideEffects: "Creates Gmail labels. Applies nothing to any message.",
    confirmation: "None needed; creating an empty label changes no mail."
  },
  {
    name: "gmail cache",
    synopsis: "gmail cache [--limit N]",
    summary: "Take a read-only snapshot of the whole Inbox and Spam so later runs are incremental.",
    details:
      "Records message IDs, content hashes, and label snapshots — never message bodies — and establishes a " +
      "Gmail history baseline when the snapshot completes fully. No AI calls and no mailbox changes. Later " +
      "runs then fetch only what changed.",
    options: [{ flag: "--limit N", description: "Cap each of the Inbox and Spam snapshots (default: no cap)." }],
    examples: ["gmail cache", "gmail cache --limit 500"],
    sideEffects: "Nothing in Gmail or Calendar. Writes only local cache rows.",
    confirmation: "None needed; it is read-only."
  },
  {
    name: "gmail uncache",
    synopsis: "gmail uncache [--yes]",
    summary: "Clear the local scan cache and history marker.",
    details:
      "The inverse of gmail cache, and entirely local: it makes the next run do a full snapshot again. Useful " +
      "when you want to force a clean re-evaluation.",
    options: [{ flag: "--yes", description: "Skip the confirmation prompt." }],
    examples: ["gmail uncache"],
    sideEffects: "Nothing in Gmail or Calendar. Deletes local cache rows only.",
    confirmation: "Asks before clearing, unless --yes is passed."
  },
  {
    name: "gmail view",
    synopsis: "gmail view [--limit N] [--previous]",
    summary: "Browse, read, search, reply, compose, and delete mail in the terminal.",
    details:
      "Refreshes from Gmail, then lists cached mail newest-first. Opening a message fetches it live (bodies " +
      "are never stored) and marks it read. Replies and new messages can be typed or AI-drafted in your own " +
      "saved writing style; either way the exact message is shown before anything sends.",
    options: [
      { flag: "--limit N", description: "Messages per page (default: 20)." },
      { flag: "--previous", description: "Open the existing cache immediately without refreshing first." }
    ],
    examples: ["gmail view", "gmail view --limit 40"],
    sideEffects:
      "Marks opened messages read, can move a message to Trash, and can send a reply or a new message that you confirm.",
    confirmation:
      "Every outbound message stops at a preview of the exact recipient, subject, and body and defaults to no. Deleting asks too, and is undoable in-session with ;u."
  },
  {
    name: "gmail send",
    synopsis: "gmail send [to] [--subject TEXT] [--ai]",
    summary: "Compose and send one email without opening the inbox.",
    details:
      "The same compose flow as gmail view's c and a commands, reachable directly from a shell prompt. The " +
      "recipient and subject are always typed by you or passed on the command line — never written by AI, " +
      "which only ever produces body text.",
    options: [
      { flag: "--subject TEXT", description: "Subject line, skipping that prompt." },
      { flag: "--ai", description: "Draft the body with AI in your saved writing style instead of typing it." }
    ],
    examples: ['gmail send "someone@example.com" --subject "Thanks"', "gmail send --ai"],
    sideEffects: "Sends exactly one email, after you confirm it.",
    confirmation: "Shows the exact To, Subject, and Body and defaults to no. No flag skips this, and it requires a terminal."
  },
  {
    name: "gmail install",
    synopsis: "gmail install",
    summary: "Guided first-time setup, from a fresh install to a previewed run.",
    details:
      "Walks the whole path in order: checks this machine, opens each Google Cloud console page for you " +
      "so you can register a Google app of your own, collects its Desktop client ID and secret, signs you " +
      "in, asks how AI should work, and finishes with a dry run. Every step detects what is already done " +
      "and offers to keep it, so it is safe to re-run after an interruption.",
    options: [],
    examples: ["gmail install"],
    sideEffects:
      "Saves your Google OAuth client, sign-in, timezone, and AI choice on this computer. Reads mail only " +
      "for the closing dry run, which changes nothing.",
    confirmation: "Asks before each step, and the run it finishes with is always a dry run — setup never cleans up mail."
  },
  {
    name: "gmail setup",
    synopsis: "gmail setup",
    summary: "Connect or reconnect Gmail, choose how AI works, and see current status.",
    details:
      "The terminal counterpart of the browser setup screen. Shows what is connected, what each Google " +
      "permission is for, and which AI option is active, and lets you change any of it. Nothing here " +
      "touches your mailbox.",
    options: [],
    examples: ["gmail setup"],
    sideEffects: "Stores or removes credentials and settings. Never reads or changes mail.",
    confirmation: "Every destructive choice (disconnecting, removing local history) is asked about explicitly."
  },
  {
    name: "gmail ui",
    synopsis: "gmail ui [--port N] [--no-open]",
    summary: "Open the local setup, command reference, and status pages in a browser.",
    details:
      "Serves three plain pages — Setup, Commands, Status — from this computer only, on 127.0.0.1, for as " +
      "long as the command runs. The command reference works without signing in. Credentials never reach " +
      "the browser: the page asks this local process to perform operations, and the process holds the keys.",
    options: [
      { flag: "--port N", description: "Listen on a specific port instead of an OS-assigned one." },
      { flag: "--no-open", description: "Print the URL instead of opening a browser." }
    ],
    examples: ["gmail ui"],
    sideEffects: "Runs a loopback web server until you stop it. Any mailbox change still requires an explicit action in the page.",
    confirmation: "Preview and run are separate actions; a preview never applies anything."
  },
  {
    name: "gmail help",
    synopsis: "gmail help [command]",
    summary: "Show every command and the full inbox keyboard reference.",
    details: "With no argument, lists all commands and the gmail view controls. With a command name, shows just that command.",
    options: [],
    examples: ["gmail help", "gmail help view"],
    sideEffects: "Nothing.",
    confirmation: "None."
  }
] as const;

export const VIEW_CONTROLS: readonly ViewControlDoc[] = [
  { keys: "up / down", description: "move the highlighted row (no Enter needed)", context: "list" },
  { keys: "enter", description: "open the highlighted row", context: "list" },
  { keys: "number", description: "type email number to open", context: "list" },
  { keys: "<n> r", description: "reply to message n immediately, without opening it first", context: "list" },
  { keys: "<n> ;r", description: 'AI-draft a reply to message n immediately (e.g. "2 ;r")', context: "list" },
  { keys: "<n> d", description: "delete (Trash) message n immediately, without opening it", context: "list" },
  { keys: "d", description: "delete (Trash) the highlighted row, without opening it", context: "list" },
  { keys: "dd", description: "delete (Trash) the highlighted row with no confirmation at all", context: "list" },
  { keys: "left / right", description: "previous or next page in the list (no Enter needed)", context: "list" },
  { keys: "n / p", description: "next or previous page", context: "list" },
  { keys: "[ / ]", description: "back or forward through prior list views", context: "list" },
  { keys: "esc", description: "go home: clear search/filters, first page (never quits)", context: "list" },
  { keys: "+ / -", description: "increase or decrease page size", context: "list" },
  { keys: "l <number>", description: "set an exact page size", context: "list" },
  { keys: "f", description: "filter by Gmail label", context: "list" },
  { keys: "s <text>", description: "search subjects and senders (s alone clears)", context: "list" },
  { keys: "c / a", description: "compose manually or with AI", context: "list" },
  { keys: ";s", description: "refresh your saved writing style from recent Sent mail", context: "list" },
  { keys: ";u", description: "undo the last delete from this session", context: "list" },
  { keys: "u", description: 'refresh Gmail (also updates the "cached ... ago" timestamp)', context: "list" },
  { keys: "q", description: "quit", context: "list" },
  { keys: "left / right", description: "previous or next message while reading one", context: "read" },
  { keys: "r / ;r", description: "reply manually or with AI while reading", context: "read" },
  { keys: "d", description: "delete (move to Trash) while reading — default answer is yes", context: "read" },
  {
    keys: "l",
    description: "show this message's link URLs (links are shown shortened and clickable in a terminal that supports it)",
    context: "read"
  },
  { keys: "o", description: "open one of this message's links in your system browser", context: "read" },
  { keys: "esc", description: "return to the message list", context: "read" }
] as const;

export const VIEW_CONTROLS_NOTE =
  'The "<n> r"/"<n> ;r" shortcuts only jump straight to composing — the same\n' +
  "exact-message confirmation screen still appears before anything sends;\n" +
  'there is no way to skip it. "Delete" always means Gmail\'s Trash (reversible\n' +
  'from Gmail itself, or instantly via ";u" for the last one this session),\n' +
  "never permanent deletion — deleting always updates the list immediately.\n" +
  'That reversibility is why "dd" may skip the question entirely while a send\n' +
  "confirmation never can: a wrong \"dd\" costs one \";u\", and repeating it walks\n" +
  "down the list deleting as it goes.";

/** The `gmail view` control reference as terminal help text, generated from the same data the web reference uses. */
export function renderViewControlsHelp(): string {
  const width = Math.max(...VIEW_CONTROLS.map((control) => control.keys.length));
  const lines = VIEW_CONTROLS.map((control) => `  ${control.keys.padEnd(width)}  ${control.description}`);
  return `\nGmail view controls:\n${lines.join("\n")}\n\n${VIEW_CONTROLS_NOTE}\n`;
}
