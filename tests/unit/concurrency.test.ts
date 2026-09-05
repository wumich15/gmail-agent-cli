import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/core/concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves input order in the results regardless of completion order", async () => {
    const delays = [30, 10, 20, 5];
    const results = await mapWithConcurrency(delays, 4, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("never runs more than `limit` calls concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 2, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("returns an empty array for empty input without calling fn", async () => {
    let called = false;
    const results = await mapWithConcurrency([], 3, async () => {
      called = true;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it("handles a limit larger than the item count", async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (n) => n * 2);
    expect(results).toEqual([2, 4]);
  });
});
