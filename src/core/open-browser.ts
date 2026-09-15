import { spawn } from "node:child_process";

/**
 * Hands a URL to the operating system's own browser launcher.
 *
 * One implementation for every place that needs it — OAuth sign-in, the
 * install wizard's console links, and `gmail view`'s "o" command — because
 * three copies had already drifted: one built a shell command string by
 * interpolating the URL, one caught only synchronous failures, and only one
 * checked the scheme.
 *
 * Two properties matter here. The URL never reaches a command interpreter,
 * so a URL containing `&`, `|`, `^` or quotes is data rather than syntax.
 * And only `http(s)` is ever launched, so a `file:` or custom scheme taken
 * from message content cannot be handed to the OS. This app never fetches
 * the URL itself; it stops at the handoff.
 *
 * Windows deliberately does NOT go through `cmd /c start`. Passing an
 * argument array is not sufficient protection there: Node only sets
 * `windowsVerbatimArguments` for `shell: true`, so libuv quotes each
 * argument itself — and libuv's `quote_cmd_arg` adds quotes only when the
 * argument contains a space, tab, or double quote. Every other `cmd.exe`
 * metacharacter, `&` included, reaches the interpreter raw and is re-parsed
 * as syntax. That breaks perfectly ordinary URLs (a Google OAuth consent
 * URL is nothing but `&`-joined parameters, so sign-in opened a truncated
 * address) and, because `gmail view`'s "o" launches a URL lifted from an
 * untrusted email body, it also turns a crafted link into command
 * execution. `rundll32 url.dll,FileProtocolHandler` opens the user's
 * default browser with no interpreter anywhere in the path.
 */
export function openUrlInBrowser(url: string, onFailure?: (url: string) => void): void {
  if (!/^https?:\/\//i.test(url)) {
    onFailure?.(url);
    return;
  }
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    // A missing launcher (no xdg-open on a minimal Linux box) arrives as an
    // asynchronous "error" event, never as a throw — and an unhandled one
    // takes the whole CLI down.
    child.on("error", () => onFailure?.(url));
    child.unref();
  } catch {
    onFailure?.(url);
  }
}
