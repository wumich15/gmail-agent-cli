import { MIGRATION_001_INITIAL_SCHEMA } from "./001_initial_schema.js";
import { MIGRATION_002_LABEL_CANDIDATES } from "./002_label_candidates.js";

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/** Ordered, append-only. Never edit a migration once it has shipped. */
export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: "initial_schema", sql: MIGRATION_001_INITIAL_SCHEMA },
  { id: 2, name: "label_candidates", sql: MIGRATION_002_LABEL_CANDIDATES }
];
