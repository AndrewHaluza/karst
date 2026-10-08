/**
 * Bump when the schema changes; drives forward migrations.
 *
 * Split out of `migrations.ts` so callers that only need the version number
 * (schema-staleness checks in `cli/assertMigrated.ts` and diagnostics'
 * `hostEvidence.ts`) don't pull the full migrator — and its write SQL — into
 * their module graph just for a constant.
 */
export const SCHEMA_VERSION = 72;
