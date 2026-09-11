import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
  isCancel: (value: unknown) => typeof value === "symbol"
}));

import * as p from "@clack/prompts";
import { chooseComposeMode } from "../../src/gmail/compose-flow.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("chooseComposeMode", () => {
  it("offers the same manual-or-AI choice the send command asks", async () => {
    vi.mocked(p.select).mockResolvedValue("ai");
    await expect(chooseComposeMode(true)).resolves.toBe(true);

    vi.mocked(p.select).mockResolvedValue("manual");
    await expect(chooseComposeMode(true)).resolves.toBe(false);
  });

  it("does not offer AI it cannot run, and says so instead of failing later", async () => {
    // Listing an option that would immediately fail is worse than not
    // listing it: the user picks it, answers the prompts, and only then
    // finds out nothing can be drafted.
    await expect(chooseComposeMode(false)).resolves.toBe(false);
    expect(p.select).not.toHaveBeenCalled();
    expect(vi.mocked(p.log.info).mock.calls.flat().join(" ")).toContain("gmail setup");
  });

  it("reports a cancelled choice as cancelled, never as a silent manual compose", async () => {
    vi.mocked(p.select).mockResolvedValue(Symbol.for("clack:cancel") as never);
    await expect(chooseComposeMode(true)).resolves.toBeNull();
  });
});
