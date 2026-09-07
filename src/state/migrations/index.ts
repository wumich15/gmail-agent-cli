import { MIGRATION_001_INITIAL_SCHEMA } from "./001_initial_schema.js";
import { MIGRATION_002_LABEL_CANDIDATES } from "./002_label_candidates.js";
import { MIGRATION_003_VIEW_COLUMNS } from "./003_view_columns.js";
import { MIGRATION_004_LABEL_CANDIDATE_VOTES } from "./004_label_candidate_votes.js";
import { MIGRATION_005_MESSAGE_CATEGORY } from "./005_message_category.js";
import { MIGRATION_006_ASSESSMENT_HAD_EVENT } from "./006_assessment_had_event.js";

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/** Ordered, append-only. Never edit a migration once it has shipped. */
export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: "initial_schema", sql: MIGRATION_001_INITIAL_SCHEMA },
  { id: 2, name: "label_candidates", sql: MIGRATION_002_LABEL_CANDIDATES },
  { id: 3, name: "view_columns", sql: MIGRATION_003_VIEW_COLUMNS },
  { id: 4, name: "label_candidate_votes", sql: MIGRATION_004_LABEL_CANDIDATE_VOTES },
  { id: 5, name: "message_category", sql: MIGRATION_005_MESSAGE_CATEGORY },
  { id: 6, name: "assessment_had_event", sql: MIGRATION_006_ASSESSMENT_HAD_EVENT }
];
