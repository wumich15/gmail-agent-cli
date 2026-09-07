import * as readline from "node:readline";

export interface KeyEvent {
  /** e.g. "return", "escape", "up", "down", or the literal character for a plain key. */
  name: string;
  ctrl: boolean;
}

/**
 * Waits for exactly one raw keypress from stdin, then restores the
 * terminal's previous raw-mode state. Used by `gmail view`'s read view for
 * single-key navigation (`esc` back, `r` reply, `;`+`r` AI-drafted reply)
 * without needing a full TUI framework.
 */
export function waitForKeypress(): Promise<KeyEvent> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // A non-raw, non-interactive stdin (piped input, no TTY at all)
      // generally never emits a 'keypress' event, which would otherwise
      // hang here forever with no diagnostic. Fail fast instead.
      reject(new Error("gmail view's read view requires an interactive terminal (stdin is not a TTY)."));
      return;
    }
    const wasRaw = process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onKeypress = (str: string | undefined, key: readline.Key | undefined): void => {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw);
      }
      process.stdin.pause();
      // Ctrl-C must still terminate the process normally even mid-read-view.
      if (key?.ctrl && key.name === "c") {
        process.exit(130);
      }
      resolve({ name: key?.name ?? str ?? "", ctrl: key?.ctrl ?? false });
    };
    process.stdin.on("keypress", onKeypress);
  });
}
