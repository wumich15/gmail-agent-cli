/**
 * The `gmail view` list-command grammar: row selectors, row actions, and
 * vim-style cursor motions.
 *
 * Kept apart from `view.ts` because it is pure text parsing with no Gmail,
 * SQLite, or terminal dependency at all, which is exactly the part worth
 * testing exhaustively — the list dispatcher then only has to decide what
 * to *do* with a parsed command, not what the user typed.
 */

/** Actions a list row (or a selected set of rows) can be given. */
export type ViewRowAction =
  | "open"
  | "reply"
  | "ai_reply"
  | "delete"
  | "delete_now"
  | "move_to_inbox"
  | "star";

/**
 * Actions that act on exactly one message and can never be applied to a
 * range. Both end at an outbound-message confirmation, and this app sends
 * only one explicitly confirmed message at a time (see CLAUDE.md's "One
 * confirmation means exactly one send") — so "reply to rows 3-5" is not a
 * shorthand this grammar is allowed to offer, however convenient it looks.
 */
export const SINGLE_ROW_ACTIONS: ReadonlySet<ViewRowAction> = new Set<ViewRowAction>(["open", "reply", "ai_reply"]);

export interface RowCommand {
  action: ViewRowAction;
  /**
   * Explicit 1-based row numbers, ascending and deduplicated, or null when
   * the user typed a bare action — which acts on the current shift+arrow
   * selection, or on the highlighted row when nothing is selected.
   */
  rows: readonly number[] | null;
}

/** Guards `3-99999999` from being expanded into an enormous array before the page bound is applied. */
const MAX_SELECTOR_ROWS = 500;

const ACTION_BY_TOKEN: ReadonlyMap<string, ViewRowAction> = new Map<string, ViewRowAction>([
  [";r", "ai_reply"],
  ["dd", "delete_now"],
  ["d", "delete"],
  ["r", "reply"],
  ["i", "move_to_inbox"],
  ["s", "star"]
]);

/** Longest token first so "dd" is never read as "d" followed by a stray "d". */
const ACTION_TOKENS = [...ACTION_BY_TOKEN.keys()].sort((left, right) => right.length - left.length);

/**
 * Parses a row selector: a single row (`4`), an inclusive range (`3-5`), or
 * a comma-separated mix of both (`1,3-5,9`). A reversed range (`5-3`) means
 * the same rows as `3-5` rather than nothing, since there is no other
 * sensible reading of it. Returns ascending, deduplicated 1-based numbers,
 * or null if the text is not a selector at all — callers rely on that null
 * to fall through to their other commands rather than treating arbitrary
 * text as a row list.
 */
export function parseRowSelector(text: string): number[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const rows = new Set<number>();
  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) return null;
    const first = Number(match[1]);
    const second = match[2] === undefined ? first : Number(match[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 1 || second < 1) return null;
    const from = Math.min(first, second);
    const to = Math.max(first, second);
    if (to - from + 1 > MAX_SELECTOR_ROWS) return null;
    for (let row = from; row <= to; row += 1) rows.add(row);
    if (rows.size > MAX_SELECTOR_ROWS) return null;
  }
  return [...rows].sort((left, right) => left - right);
}

/**
 * Parses one row command in any of the three shapes the list accepts:
 *
 * - `<selector> <action>` — `3 d`, `2 ;r`, `3-5 dd` (the original shorthand)
 * - `<action> <selector>` — `d 3-5`, `s 1,4`, `i 2-6`
 * - `<action>` — acts on the shift+arrow selection, or the highlighted row
 *
 * A bare single number is `open`, which is the long-standing "type a
 * message number to open it" behavior. Whitespace between the selector and
 * the action is optional (`2;r` and `d3-5` both parse). Returns null for
 * anything that is not a row command, so the dispatcher's other commands
 * still get their turn.
 */
export function parseRowCommand(cmd: string): RowCommand | null {
  const trimmed = cmd.trim().toLowerCase().replace(/\s+/g, " ");
  if (trimmed === "") return null;

  const bareSelector = parseRowSelector(trimmed);
  if (bareSelector) return bareSelector.length === 1 ? { action: "open", rows: bareSelector } : null;

  for (const token of ACTION_TOKENS) {
    const action = ACTION_BY_TOKEN.get(token)!;
    if (trimmed === token) return { action, rows: null };
    if (trimmed.startsWith(token)) {
      const rows = parseRowSelector(trimmed.slice(token.length));
      if (rows) return { action, rows };
    }
    if (trimmed.endsWith(token)) {
      const rows = parseRowSelector(trimmed.slice(0, trimmed.length - token.length));
      if (rows) return { action, rows };
    }
  }
  return null;
}

export interface CursorMotion {
  direction: "up" | "down";
  /** How many rows to move; always at least 1. */
  count: number;
}

/**
 * Parses the vim-style cursor motions `j`/`k` and their counted forms
 * (`5j`, `3 k`). Movement stops at the edge of the page rather than
 * wrapping, which is both what vim does and what makes a count meaningful —
 * `20j` on a short page should land on the last row, not somewhere in the
 * middle after wrapping around.
 */
export function parseCursorMotion(cmd: string): CursorMotion | null {
  const match = /^(\d*)\s*([jk])$/.exec(cmd.trim().toLowerCase());
  if (!match) return null;
  const count = match[1] === "" ? 1 : Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 1) return null;
  return { direction: match[2] === "j" ? "down" : "up", count };
}

/**
 * The rows of `<selector>` that actually exist on the current page, as
 * 0-based indexes. Out-of-range numbers are dropped rather than failing the
 * whole command: `d 3-99` on a twenty-row page plainly means "from 3 to the
 * end", and refusing it would be pedantry.
 */
export function resolveRowsOnPage(rows: readonly number[], pageItemCount: number): number[] {
  return rows.filter((row) => row >= 1 && row <= pageItemCount).map((row) => row - 1);
}
