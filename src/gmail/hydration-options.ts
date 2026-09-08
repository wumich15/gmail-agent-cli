/** Shared read-transport controls for work and cache. Batch size never changes quota pace. */
export function batchHydrationEnabled(): boolean {
  const raw = (process.env["GMAIL_AGENT_BATCH_HYDRATION"] ?? "1").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function configuredBatchSize(): number {
  const raw = process.env["GMAIL_AGENT_BATCH_SIZE"];
  if (raw === undefined) return 50;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 1 || size > 50) {
    throw new Error("GMAIL_AGENT_BATCH_SIZE must be an integer from 1 to 50.");
  }
  return size;
}
