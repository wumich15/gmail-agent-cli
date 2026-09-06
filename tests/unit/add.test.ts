import { describe, expect, it, vi } from "vitest";
import { runAdd } from "../../src/commands/add.js";
import { RuleConflictError, AuthRequiredError, EXIT_CODES } from "../../src/core/errors.js";

vi.mock("../../src/commands/spam.js", () => ({
  runSpam: vi.fn()
}));
vi.mock("../../src/commands/important.js", () => ({
  runImportant: vi.fn()
}));

import { runSpam } from "../../src/commands/spam.js";

describe("runAdd", () => {
  it("rejects an unknown rule type without calling anything", async () => {
    const code = await runAdd("bogus", ["x"], { yes: false });
    expect(code).toBe(EXIT_CODES.invalidOrAuthRequired);
    expect(runSpam).not.toHaveBeenCalled();
  });

  it("attempts every category even when one in the middle throws a RuleConflictError", async () => {
    // Regression: a RuleConflictError (or any other typed GmailAgentError)
    // from one category used to propagate uncaught out of the loop,
    // silently aborting every category after it despite this function's
    // own documented "continue independent actions" contract.
    const mockRunSpam = vi.mocked(runSpam);
    mockRunSpam
      .mockResolvedValueOnce(EXIT_CODES.ok) // "LinkedIn"
      .mockRejectedValueOnce(new RuleConflictError("conflicts with an important rule")) // "NYT"
      .mockResolvedValueOnce(EXIT_CODES.ok); // "Amazon"

    const code = await runAdd("spam", ["LinkedIn", "NYT", "Amazon"], { yes: true });

    expect(mockRunSpam).toHaveBeenCalledTimes(3);
    expect(mockRunSpam).toHaveBeenNthCalledWith(3, "Amazon", expect.anything());
    // The conflict's own exit code (safetyBlocked) surfaces as the worst result.
    expect(code).toBe(EXIT_CODES.safetyBlocked);
  });

  it("still rethrows a genuinely unexpected (non-GmailAgentError) exception rather than silently continuing", async () => {
    const mockRunSpam = vi.mocked(runSpam);
    mockRunSpam.mockRejectedValueOnce(new TypeError("unexpected bug"));
    await expect(runAdd("spam", ["A"], { yes: true })).rejects.toThrow("unexpected bug");
  });

  it("converts AuthRequiredError into a clear message and exit code without throwing", async () => {
    const mockRunSpam = vi.mocked(runSpam);
    mockRunSpam.mockRejectedValueOnce(new AuthRequiredError());
    const code = await runAdd("spam", ["A"], { yes: true });
    expect(code).toBe(EXIT_CODES.invalidOrAuthRequired);
  });
});
