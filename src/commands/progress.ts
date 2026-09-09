import type { ClassifierProgress, ReadProgress } from "../core/orchestrator.js";

interface ProgressOutput {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
}

export interface ProgressOptions {
  /** JSON callers disable terminal redraws, including when stderr is a TTY. */
  interactive?: boolean;
  output?: ProgressOutput;
  now?: () => number;
}

interface TerminalProgress {
  start(detail: string, total?: number): void;
  update(completed: number, total?: number, failed?: number): void;
  finish(success?: boolean): void;
  onQuotaWait(waitMs: number): void;
  writeMessage(message: string): void;
}

/** A content-free stderr display shared by Gmail reads and classification. */
function createTerminalProgress(title: string, options: ProgressOptions): TerminalProgress {
  const output = options.output ?? process.stderr;
  const interactive = (options.interactive ?? true) && Boolean(output.isTTY);
  const now = options.now ?? Date.now;
  let detail = "";
  let total: number | undefined;
  let completed = 0;
  let failed = 0;
  let startedAt = 0;
  let cooldownUntil = 0;
  let active = false;
  let lineLength = 0;
  let lastReportedCompleted = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const endLine = (): void => {
    if (lineLength > 0) output.write("\n");
    lineLength = 0;
  };

  const draw = (status?: string): void => {
    const percent = total === undefined ? undefined : total === 0 ? 100 : Math.min(100, Math.floor(completed / total * 100));
    const width = 20;
    const filled = percent === undefined ? 0 : Math.round(percent / 100 * width);
    const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
    const count = total === undefined ? completed > 0 ? `${completed} found` : "" : `${completed}/${total}`;
    const seconds = Math.max(0, Math.floor((now() - startedAt) / 1000));
    const waitSeconds = Math.max(0, Math.ceil((cooldownUntil - now()) / 1000));
    const pieces = [!status && waitSeconds > 0 ? `Gmail quota cooldown ${waitSeconds}s` : detail,
      status, count, failed > 0 ? `${failed} failed` : "", `${seconds}s elapsed`].filter(Boolean);
    const line = `${title} [${bar}]${percent === undefined ? "" : ` ${percent}%`} ${pieces.join("; ")}`;
    if (interactive) {
      // Padding clears a shorter previous line without emitting ANSI codes.
      // Leave the last column unused so the terminal does not wrap a redraw.
      const limit = Math.max(1, (output.columns ?? 160) - 1);
      const visible = line.length > limit ? `${line.slice(0, Math.max(0, limit - 3))}...` : line;
      output.write(`\r${visible}${" ".repeat(Math.max(0, lineLength - visible.length))}`);
      lineLength = visible.length;
    } else {
      output.write(`${line}\n`);
    }
    lastReportedCompleted = completed;
  };

  return {
    start(nextDetail, nextTotal) {
      endLine();
      if (timer !== undefined) clearInterval(timer);
      detail = nextDetail;
      total = nextTotal === undefined ? undefined : Math.max(0, Math.floor(nextTotal));
      completed = 0;
      failed = 0;
      startedAt = now();
      lastReportedCompleted = 0;
      active = true;
      draw();
      if (interactive) {
        timer = setInterval(() => draw(), 1000);
        timer.unref();
      }
    },
    update(nextCompleted, nextTotal, nextFailed) {
      if (!active) return;
      completed = Math.max(0, Math.floor(nextCompleted));
      if (nextTotal !== undefined) total = Math.max(0, Math.floor(nextTotal));
      if (nextFailed !== undefined) failed = Math.max(0, Math.floor(nextFailed));
      const step = total === undefined ? 100 : Math.max(10, Math.ceil(total / 10));
      if (interactive || completed - lastReportedCompleted >= step ||
        (total !== undefined && completed === total && completed !== lastReportedCompleted)) draw();
    },
    finish(success = true) {
      if (!active) return;
      active = false;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      draw(success ? "Complete" : "Stopped with errors");
      endLine();
    },
    onQuotaWait(waitMs) {
      if (!Number.isFinite(waitMs) || waitMs <= 0) return;
      const wasWaiting = cooldownUntil > now();
      cooldownUntil = Math.max(cooldownUntil, now() + waitMs);
      // Concurrent requests share one cooldown; don't print one line for
      // every worker waiting on the same retry deadline in a redirected log.
      if (active && (interactive || !wasWaiting)) draw();
    },
    writeMessage(message) {
      endLine();
      output.write(`${message}\n`);
    }
  };
}

export type ReadProgressDisplay = ReadProgress & Pick<TerminalProgress, "onQuotaWait" | "writeMessage">;

export function createReadProgress(options: ProgressOptions & { title?: string } = {}): ReadProgressDisplay {
  // Not just "Gmail reads": this one progress display is reused for the
  // write/mutation phase too (see work.ts's "applying" phase below) — a
  // fixed "reads" title stayed on screen through Trash/label writes and,
  // combined with reusing the "reconciling" phase for both the real
  // post-scan history sync AND the unrelated write-application step, made
  // a real Gmail quota cooldown during writes look like a stalled read.
  const progress = createTerminalProgress(options.title ?? "Gmail", options);
  const phases = {
    preparing: "Reading mailbox details",
    discovering: "Discovering messages",
    hydrating: "Reading messages",
    reconciling: "Reconciling mailbox changes",
    applying: "Applying changes"
  };
  return {
    onPhase: (phase, total) => progress.start(phases[phase], total),
    onProgress: (completed, total, failed) => progress.update(completed, total, failed),
    onFinish: (success) => progress.finish(success),
    onQuotaWait: (waitMs) => progress.onQuotaWait(waitMs),
    writeMessage: (message) => progress.writeMessage(message)
  };
}

export function createClassifierProgress(options: ProgressOptions = {}): ClassifierProgress {
  const progress = createTerminalProgress("Classifier", options);
  return {
    onStart: (total) => progress.start("Evaluating messages", total),
    onProgress: (completed, total) => progress.update(completed, total),
    onFinish: () => progress.finish()
  };
}
