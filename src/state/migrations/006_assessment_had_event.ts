/**
 * Records whether a cached assessment originally contained an event
 * candidate. The event payload itself remains deliberately absent from
 * SQLite; this flag lets callers avoid treating an incomplete cached
 * reconstruction as equivalent to the original assessment.
 */
export const MIGRATION_006_ASSESSMENT_HAD_EVENT = `
ALTER TABLE messages ADD COLUMN assessment_had_event INTEGER CHECK (assessment_had_event IN (0, 1));
`;
