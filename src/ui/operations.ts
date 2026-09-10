import { bootstrap, reloadConfig, type CliContext } from "../core/bootstrap.js";
import { connectGoogleAccount } from "../core/connect.js";
import {
  disconnectAccount,
  getAiStatus,
  getConnectionStatus,
  type AiStatus,
  type ConnectionStatus
} from "../core/onboarding.js";
import { applyAiAccessChoice, checkLocalRuntime, type AiAccessId } from "../core/ai-access.js";
import { loadOrCreateDefaultConfig } from "../config/load.js";
import { runWork } from "../commands/work.js";
import { COMMANDS, VIEW_CONTROLS, VIEW_CONTROLS_NOTE } from "../docs/command-reference.js";
import type { JsonSummaryOutput } from "../summary/render-json.js";

/**
 * The complete set of operations the browser page may ask this process to
 * perform, as typed functions.
 *
 * The page never sends a command line and this module never builds one:
 * there is no path from a request body to a shell, and no path from the
 * page to a credential. Google tokens and any AI key stay in this process
 * and the OS credential store, and nothing here returns one.
 */

export interface RunState {
  kind: "idle" | "connecting" | "previewing" | "running";
  startedAt: string | null;
  /** Short, content-free progress text. Never contains a subject or sender. */
  note: string | null;
  /** The consent URL while connecting, so the page can offer a link if the browser did not open. */
  authorizeUrl?: string | null;
  lastError: string | null;
  lastPreview: (JsonSummaryOutput & { runId: string | null }) | null;
  lastRun: (JsonSummaryOutput & { runId: string | null }) | null;
}

export interface UiStatus {
  connection: ConnectionStatus;
  ai: AiStatus;
  run: RunState;
}

/** An error with an HTTP status the server can return as-is. Messages here are always safe to show. */
export class UiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "UiError";
  }
}

/**
 * One in-process guard for the whole UI session. Combined with the
 * existing per-account file lock inside `runWork`, this makes concurrent
 * mutation impossible: the file lock stops a second *process*, and this
 * stops a second click in the same one from queueing work the user cannot
 * see or cancel.
 */
export class UiSession {
  private state: RunState = {
    kind: "idle",
    startedAt: null,
    note: null,
    lastError: null,
    lastPreview: null,
    lastRun: null
  };

  private cancelConnect: (() => void) | null = null;

  constructor(private readonly ctx: CliContext = bootstrap()) {}

  get context(): CliContext {
    return this.ctx;
  }

  runState(): RunState {
    return { ...this.state };
  }

  busy(): boolean {
    return this.state.kind !== "idle";
  }

  async status(): Promise<UiStatus> {
    const connection = await getConnectionStatus(this.ctx);
    const ai = await getAiStatus(this.ctx, connection.accountHash);
    return { connection, ai, run: this.runState() };
  }

  /**
   * Starts Google sign-in in the background and returns immediately, so the
   * page stays responsive while the user is in Google's consent screen. The
   * result is observed by polling `status`.
   */
  startConnect(timezone: string | null): void {
    if (this.busy()) throw new UiError("Something is already running. Wait for it to finish or cancel it.", 409);
    this.state = {
      ...this.state,
      kind: "connecting",
      startedAt: new Date().toISOString(),
      note: "Waiting for Google sign-in in your browser.",
      authorizeUrl: null,
      lastError: null
    };

    let cancelled = false;
    this.cancelConnect = () => {
      cancelled = true;
    };

    void connectGoogleAccount(this.ctx, {
      onAuthorizeUrl: (url) => {
        this.state = { ...this.state, authorizeUrl: url };
      },
      resolveTimezone: (detected) => timezone || detected
    })
      .then((result) => {
        this.state = {
          ...this.state,
          kind: "idle",
          authorizeUrl: null,
          note:
            result.missingScopes.length > 0
              ? `Connected as ${result.emailDisplay}, but Google did not report granting: ${result.missingScopes.join(", ")}.`
              : `Connected as ${result.emailDisplay}. Nothing in your mailbox was changed.`
        };
      })
      .catch((error: unknown) => {
        this.state = {
          ...this.state,
          kind: "idle",
          authorizeUrl: null,
          note: null,
          lastError: cancelled ? "Sign-in cancelled." : errorText(error)
        };
      });
  }

  /**
   * Abandons a sign-in attempt. The loopback listener closes on its own
   * timeout, and no credential is written unless Google actually completed
   * the exchange, so this is safe at any point.
   */
  cancelCurrentConnect(): void {
    this.cancelConnect?.();
    this.cancelConnect = null;
    if (this.state.kind === "connecting") {
      this.state = { ...this.state, kind: "idle", authorizeUrl: null, note: null, lastError: "Sign-in cancelled." };
    }
  }

  async setAiAccess(choice: AiAccessId, apiKey: string | null): Promise<void> {
    const connection = await getConnectionStatus(this.ctx);
    const config = this.ctx.config ?? loadOrCreateDefaultConfig(Intl.DateTimeFormat().resolvedOptions().timeZone);
    await applyAiAccessChoice({
      config,
      choice,
      apiKey,
      accountHash: connection.accountHash ?? "",
      credentialStore: this.ctx.credentialStore
    });
    reloadConfig(this.ctx);
  }

  async localRuntime(): Promise<{ reachable: boolean; models: string[]; problem?: string }> {
    const status = await checkLocalRuntime();
    return {
      reachable: status.reachable,
      models: status.models,
      ...(status.problem ? { problem: status.problem } : {})
    };
  }

  async disconnect(removeHistory: boolean): Promise<void> {
    const connection = await getConnectionStatus(this.ctx);
    if (!connection.accountHash) throw new UiError("No account is connected.", 400);
    if (this.busy()) throw new UiError("Something is already running. Wait for it to finish first.", 409);
    await disconnectAccount(this.ctx, connection.accountHash, { removeHistory });
  }

  /**
   * A preview and a real cleanup are the same operation with one flag
   * different, deliberately: the preview a user approves has to be produced
   * by the code that will do the work, not by a separate estimate that
   * could disagree with it.
   */
  startWork(options: { dryRun: boolean; limit: number | undefined }): void {
    if (this.busy()) throw new UiError("Something is already running. Wait for it to finish or cancel it.", 409);
    this.state = {
      ...this.state,
      kind: options.dryRun ? "previewing" : "running",
      startedAt: new Date().toISOString(),
      note: options.dryRun ? "Previewing. Nothing is being changed." : "Applying changes.",
      lastError: null
    };

    void runWork({
      dryRun: options.dryRun,
      json: true,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      onJsonSummary: (summary) => {
        this.state = options.dryRun ? { ...this.state, lastPreview: summary } : { ...this.state, lastRun: summary };
      }
    })
      .then(() => {
        this.state = {
          ...this.state,
          kind: "idle",
          note: options.dryRun ? "Preview finished. Nothing was changed." : "Cleanup finished."
        };
      })
      .catch((error: unknown) => {
        this.state = { ...this.state, kind: "idle", note: null, lastError: errorText(error) };
      });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The command reference, exactly as `gmail help` renders it, for the Commands view. */
export function commandReference() {
  return { commands: COMMANDS, viewControls: VIEW_CONTROLS, viewControlsNote: VIEW_CONTROLS_NOTE };
}
