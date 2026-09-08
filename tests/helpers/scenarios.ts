/** Consolidate related hook-free cases while still executing every named scenario after a failure. */
export async function runScenarios(scenarios: readonly { name: string; run: () => unknown }[]): Promise<void> {
  const failures: Error[] = [];
  for (const scenario of scenarios) {
    try { await scenario.run(); }
    catch (cause) { failures.push(new Error(scenario.name, { cause })); }
  }
  if (failures.length > 0) throw new AggregateError(failures, failures.map((error) => error.message).join("; "));
}
