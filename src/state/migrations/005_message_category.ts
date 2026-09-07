/**
 * Adds the one remaining field needed to fully reconstruct a cached
 * assessment without an AI call: the AI-proposed topical category (a
 * short derived label like "Shopping" or "Receipts" — never verbatim
 * email content, so it's fine to persist per CLAUDE.md's "Keep secrets,
 * full email bodies... and AI sourceEvidence out of SQLite"). Without
 * this column, `core/orchestrator.ts`'s assessment-reuse cache would
 * still need an AI call just to re-propose a message's category on every
 * incremental rescan, defeating part of the point of the cache.
 */
export const MIGRATION_005_MESSAGE_CATEGORY = `
ALTER TABLE messages ADD COLUMN category TEXT;
`;
