import { exec } from "node:child_process";
import pc from "picocolors";
import { startUiServer } from "../ui/server.js";
import { EXIT_CODES } from "../core/errors.js";

export interface UiOptions {
  port?: number;
  /** Commander sets this false for --no-open. */
  open: boolean;
}

/**
 * Serves the local Setup / Commands / Status pages until interrupted.
 *
 * The command intentionally blocks: the server's lifetime is the command's
 * lifetime, so there is no background daemon to forget about, no port left
 * listening after the terminal is closed, and no session token outliving
 * the process that minted it.
 */
export async function runUi(options: UiOptions): Promise<number> {
  const handle = await startUiServer(options.port !== undefined ? { port: options.port } : {});

  console.error(pc.bold("Gmail agent is running in your browser."));
  console.error(`  ${handle.url}`);
  console.error(
    pc.dim(
      "This address only works on this computer, and the key in it is valid only while this command runs.\n" +
        "Press Ctrl-C to stop."
    )
  );

  if (options.open) {
    openInBrowser(handle.url);
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      void handle.close().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  console.error("Stopped.");
  return EXIT_CODES.ok;
}

function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {
    // Best effort; the URL is printed above either way.
  });
}
