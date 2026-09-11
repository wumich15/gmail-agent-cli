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
 * Two properties matter here. The URL never reaches a shell: `spawn` is given
 * an argument array, so a URL containing quotes, `&`, or `;` is data rather
 * than syntax. And only `http(s)` is ever launched, so a `file:` or custom
 * scheme taken from message content cannot be handed to the OS. This app
 * never fetches the URL itself; it stops at the handoff.
 */
export function openUrlInBrowser(url: string, onFailure?: (url: string) => void): void {
  if (!/^https?:\/\//i.test(url)) {
    onFailure?.(url);
    return;
  }
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  try {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
    // A missing launcher (no xdg-open on a minimal Linux box) arrives as an
    // asynchronous "error" event, never as a throw — and an unhandled one
    // takes the whole CLI down.
    child.on("error", () => onFailure?.(url));
    child.unref();
  } catch {
    onFailure?.(url);
  }
}
