/**
 * Placeholder for the classifier evaluation harness described in CLAUDE.md
 * ("Testing and release gates" > Classifier evaluation). There is no
 * labeled evaluation set or classifier implementation yet — this exists so
 * `pnpm eval` fails clearly instead of with a missing-module error.
 */
console.error(
  "No classifier evaluation set exists yet: the AI classifier itself is not implemented in this build."
);
process.exitCode = 1;
