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
export type CommandInput =
  /** A key in `immediateKeys` was pressed on an empty line — no Enter needed. */
  | { kind: "key"; name: string }
  | { kind: "line"; value: string }
  | { kind: "cancel" };

/**
 * A one-line prompt that answers either to a bare keypress or to typed
 * input. `gmail view`'s list needs both: arrow keys have to page instantly
 * (a readline prompt would swallow them as cursor movement), while a
 * message number or a multi-character command still has to be typed and
 * submitted with Enter. Keys in `immediateKeys` only short-circuit while
 * nothing has been typed yet, so they never interrupt a command in progress.
 */
export function readCommandLine(prompt: string, immediateKeys: readonly string[] = []): Promise<CommandInput> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("gmail view requires an interactive terminal (stdin is not a TTY)."));
      return;
    }
    const wasRaw = process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let buffer = "";
    const redraw = (): void => {
      // Return to column 0 and clear the line so a backspace visibly erases.
      process.stdout.write(`\r\x1b[K${prompt}${buffer}`);
    };

    const restore = (): void => {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };

    const finish = (result: CommandInput): void => {
      restore();
      process.stdout.write("\n");
      resolve(result);
    };

    const onKeypress = (str: string | undefined, key: readline.Key | undefined): void => {
      if (key?.ctrl && key.name === "c") {
        restore();
        process.exit(130);
      }
      const name = key?.name ?? "";
      if (name === "return" || name === "enter") {
        finish({ kind: "line", value: buffer });
        return;
      }
      if (name === "escape") {
        finish({ kind: "cancel" });
        return;
      }
      if (name === "backspace") {
        buffer = buffer.slice(0, -1);
        redraw();
        return;
      }
      if (buffer.length === 0 && immediateKeys.includes(name)) {
        finish({ kind: "key", name });
        return;
      }
      // Printable characters only. Arrow keys arrive as multi-character
      // escape sequences, so this never echoes one as literal text.
      const code = str?.length === 1 ? str.charCodeAt(0) : undefined;
      if (code !== undefined && code >= 32 && code !== 127) {
        buffer += str;
        redraw();
      }
    };

    process.stdin.on("keypress", onKeypress);
    redraw();
  });
}

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
