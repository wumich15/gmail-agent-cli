/**
 * Adds the minimal, low-sensitivity metadata `gmail view` needs to render
 * a browsable subject-line list straight from `gmail cache`'s local data:
 * subject, sender display string, and Gmail's internalDate. Deliberately
 * NOT the message body — CLAUDE.md's "keep... full email bodies... out of
 * SQLite" is unchanged; opening a message in `gmail view` always does a
 * live fetch for the body, never a cached one.
 */
export const MIGRATION_003_VIEW_COLUMNS = `
ALTER TABLE messages ADD COLUMN subject TEXT;
ALTER TABLE messages ADD COLUMN sender_display TEXT;
ALTER TABLE messages ADD COLUMN internal_date TEXT;
`;
