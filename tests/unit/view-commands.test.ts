import { describe, expect, it } from "vitest";
import {
  SINGLE_ROW_ACTIONS,
  parseCursorMotion,
  parseRowCommand,
  parseRowSelector,
  resolveRowsOnPage
} from "../../src/commands/view-commands.js";

describe("row selectors", () => {
  it("parses a single row, a range, and a comma-separated mix", () => {
    expect(parseRowSelector("4")).toEqual([4]);
    expect(parseRowSelector("3-5")).toEqual([3, 4, 5]);
    expect(parseRowSelector("1,3-5,9")).toEqual([1, 3, 4, 5, 9]);
  });

  it("reads a reversed range as the same rows, and deduplicates overlaps", () => {
    expect(parseRowSelector("5-3")).toEqual([3, 4, 5]);
    expect(parseRowSelector("3-5,4,5")).toEqual([3, 4, 5]);
  });

  it("tolerates the spacing a person actually types", () => {
    expect(parseRowSelector("  3 - 5 ")).toEqual([3, 4, 5]);
    expect(parseRowSelector("1, 4")).toEqual([1, 4]);
  });

  it("returns null for anything that is not a selector, so other commands still get their turn", () => {
    expect(parseRowSelector("")).toBeNull();
    expect(parseRowSelector("invoice")).toBeNull();
    expect(parseRowSelector("0")).toBeNull();
    expect(parseRowSelector("3-")).toBeNull();
    expect(parseRowSelector("-3")).toBeNull();
    expect(parseRowSelector("3,,5")).toBeNull();
  });

  it("refuses a range too large to be a page of mail rather than expanding it", () => {
    expect(parseRowSelector("1-99999999")).toBeNull();
  });
});

describe("row commands", () => {
  it("accepts a selector after the action", () => {
    expect(parseRowCommand("d 3-5")).toEqual({ action: "delete", rows: [3, 4, 5] });
    expect(parseRowCommand("dd 3-5")).toEqual({ action: "delete_now", rows: [3, 4, 5] });
    expect(parseRowCommand("s 1,4")).toEqual({ action: "star", rows: [1, 4] });
    expect(parseRowCommand("i 2-3")).toEqual({ action: "move_to_inbox", rows: [2, 3] });
  });

  it("still accepts the original selector-first shorthand", () => {
    expect(parseRowCommand("2 ;r")).toEqual({ action: "ai_reply", rows: [2] });
    expect(parseRowCommand("3 r")).toEqual({ action: "reply", rows: [3] });
    expect(parseRowCommand("1 d")).toEqual({ action: "delete", rows: [1] });
    expect(parseRowCommand("4 i")).toEqual({ action: "move_to_inbox", rows: [4] });
    expect(parseRowCommand("3-5 dd")).toEqual({ action: "delete_now", rows: [3, 4, 5] });
  });

  it("tolerates a missing space on either side", () => {
    expect(parseRowCommand("2;r")).toEqual({ action: "ai_reply", rows: [2] });
    expect(parseRowCommand("d3-5")).toEqual({ action: "delete", rows: [3, 4, 5] });
  });

  it("reads a bare action as 'use the current selection'", () => {
    expect(parseRowCommand("d")).toEqual({ action: "delete", rows: null });
    expect(parseRowCommand("dd")).toEqual({ action: "delete_now", rows: null });
    expect(parseRowCommand("s")).toEqual({ action: "star", rows: null });
    expect(parseRowCommand("i")).toEqual({ action: "move_to_inbox", rows: null });
  });

  it("never reads 'dd' as a 'd' with a stray character", () => {
    expect(parseRowCommand("dd")).toEqual({ action: "delete_now", rows: null });
    expect(parseRowCommand("dd 2")).toEqual({ action: "delete_now", rows: [2] });
  });

  it("reads a bare number as 'open it', and a bare range as neither", () => {
    expect(parseRowCommand("2")).toEqual({ action: "open", rows: [2] });
    // A range selects rows instead; the list handles that separately.
    expect(parseRowCommand("3-5")).toBeNull();
  });

  it("keeps reply and AI reply to exactly one message, so a confirmation is never one of several", () => {
    expect([...SINGLE_ROW_ACTIONS].sort()).toEqual(["ai_reply", "open", "reply"]);
  });

  it("returns null for the list's other commands and for garbage", () => {
    for (const cmd of ["", "q", "n", "p", "u", "c", "a", ";c", ";s", ";u", "f", "l 20", "/invoice", "gmail --limit 5", "2 x"]) {
      expect(parseRowCommand(cmd), cmd).toBeNull();
    }
  });

  it("refuses row zero", () => {
    expect(parseRowCommand("0 d")).toBeNull();
  });
});

describe("vim cursor motions", () => {
  it("parses bare and counted motions", () => {
    expect(parseCursorMotion("j")).toEqual({ direction: "down", count: 1 });
    expect(parseCursorMotion("k")).toEqual({ direction: "up", count: 1 });
    expect(parseCursorMotion("5j")).toEqual({ direction: "down", count: 5 });
    expect(parseCursorMotion("5k")).toEqual({ direction: "up", count: 5 });
    expect(parseCursorMotion(" 12 j ")).toEqual({ direction: "down", count: 12 });
  });

  it("returns null for anything else", () => {
    expect(parseCursorMotion("jj")).toBeNull();
    expect(parseCursorMotion("j5")).toBeNull();
    expect(parseCursorMotion("0j")).toBeNull();
    expect(parseCursorMotion("d")).toBeNull();
  });
});

describe("resolving selected rows against the page", () => {
  it("converts 1-based rows to 0-based indexes", () => {
    expect(resolveRowsOnPage([1, 3], 5)).toEqual([0, 2]);
  });

  it("drops rows past the end of the page rather than failing the whole command", () => {
    expect(resolveRowsOnPage([3, 4, 5, 6], 4)).toEqual([2, 3]);
    expect(resolveRowsOnPage([9], 4)).toEqual([]);
  });
});
