import { MIGRATION_001_INITIAL_SCHEMA } from "./001_initial_schema.js";

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/** Ordered, append-only. Never edit a migration once it has shipped. */
export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: "initial_schema", sql: MIGRATION_001_INITIAL_SCHEMA }
];
