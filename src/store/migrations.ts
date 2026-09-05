import type { Database } from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/**
 * Where `schema.sql` sits, resolved against the TWO compiled outputs that can
 * contain this module — never against this module's own `import.meta.url`,
 * which collapses to the enclosing bundle's directory and made the lookup
 * `dist/schema.sql`, a path `scripts/copy-assets.mjs` never writes.
 *
 * `RUNTIME_ASSETS_ROOT` is `src/` unbundled and `dist/` inside
 * `dist/extension.js`, so `store/schema.sql` under it is right in both. The
 * agent-facing CLI is a SECOND esbuild bundle one level deeper
 * (`dist/cli/main.js` — see docs/arch/cli.md) and it is the only caller of
 * `readSchema`, so its root resolves to `dist/cli/`; the sibling candidate
 * covers it. First existing path wins; the read itself reports a genuinely
 * missing asset.
 */
const SCHEMA_CANDIDATES = [
  join(RUNTIME_ASSETS_ROOT, 'store', 'schema.sql'),
  join(RUNTIME_ASSETS_ROOT, '..', 'store', 'schema.sql'),
] as const;

function schemaPath(): string {
  return SCHEMA_CANDIDATES.find((candidate) => existsSync(candidate)) ?? SCHEMA_CANDIDATES[0];
}

/**
 * The v1 base schema as text — what `migrate` runs for a fresh DB and what the
 * CLI's `karst test reset` re-runs after dropping every table (it cannot call
 * `migrate` itself: the CLI runs under `node:sqlite`, whose `DatabaseSync`
 * lacks the `pragma`/`transaction` surface `migrate` is typed against). A fresh
 * schema.sql IS the complete current schema — every later version's columns and
 * tables are mirrored into it — so exec'ing it and stamping `SCHEMA_VERSION`
 * reproduces exactly what `migrate()` produces on a brand-new registry.
 */
export function readSchema(): string {
  return readFileSync(schemaPath(), 'utf8');
}

/** Bump when the schema changes; drives forward migrations. */
export const SCHEMA_VERSION = 56;

/** v2 ticket-field columns added to `tickets`; mirror schema.sql for fresh DBs. */
const V2_TICKET_COLUMNS = [
  'description',
  'brief',
  'source_ref',
  'source_fetched_at',
  'approach',
  'selected_repos',
] as const;

/**
 * Bring a freshly opened DB up to SCHEMA_VERSION.
 *
 * v1 is idempotent (schema.sql uses CREATE TABLE IF NOT EXISTS), so re-running on
 * an existing DB never wipes data. Later versions append numbered steps here,
 * gated on the DB's current `user_version`.
 *
 * v2 adds ticket-field columns to `tickets`. A fresh DB already has them (schema.sql
 * carries them); the ALTERs below only run for a legacy v1 DB being upgraded, and
 * each is guarded against the "already present" case so the step is idempotent.
 */
/** Current column names on `table` (for idempotent ALTER guards). */
function tableColumns(db: Database, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info('${table}')`)
      .all()
      .map((r) => (r as { name: string }).name),
  );
}

/** Current column names on the `tickets` table (for idempotent ALTER guards). */
function ticketColumns(db: Database): Set<string> {
  return tableColumns(db, 'tickets');
}

/**
 * v16 PR metadata columns, all TEXT (ISO stamps and a JSON blob — SQLite has no
 * date or json type). Mirror schema.sql for fresh DBs.
 */
const V16_PR_COLUMNS = ['head_ref', 'base_ref', 'created_at', 'merged_at', 'comments'] as const;

/**
 * v21 invocation-identity columns on `gate_runs`, all TEXT. Mirror schema.sql
 * for fresh DBs. `args` is a JSON array (SQLite has no array type).
 */
const V21_GATE_RUN_COLUMNS = ['repo', 'command', 'args'] as const;

/**
 * v17's token_usage table + aggregation indexes, for a legacy DB being upgraded.
 * Kept byte-identical in intent to the schema.sql block it mirrors (see the
 * comments there); every statement is IF NOT EXISTS so a fresh DB skips it.
 */
const TOKEN_USAGE_DDL = `
CREATE TABLE IF NOT EXISTS token_usage (
  id                 INTEGER PRIMARY KEY,
  project_id         INTEGER,
  ticket_id          INTEGER,
  call_site          TEXT NOT NULL,
  provider           TEXT,
  model              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  estimated          INTEGER NOT NULL DEFAULT 0,
  outcome            TEXT NOT NULL,
  recorded_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_project_time ON token_usage(project_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_ticket ON token_usage(ticket_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_site ON token_usage(project_id, call_site, recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(project_id, model, recorded_at);
`;

/** Tables whose `service` column became `repo` in v10. */
const V10_RENAMED_TABLES = ['servers', 'port_allocations', 'baseline_refs'] as const;

/**
 * v35's eight graph tables (Slice 2, design "Persistence"). Byte-identical in
 * intent to the schema.sql block it mirrors — `db.test.ts` pins that with a
 * `toContain` over this exact text. Exported so the interruption-atomicity
 * test can drive the REAL step DDL inside a transaction.
 *
 * Insert-only rowid tables (no AUTOINCREMENT): none of the eight deletes a row
 * outside `deleteTicket`'s explicit ordered sequence, so the largest rowid
 * never decreases. Closed-value CHECKs enforce status MEMBERSHIP only;
 * transition legality is application code, pinned by the transition-map tests.
 */
export const GRAPH_MIGRATION_DDL = `
CREATE TABLE IF NOT EXISTS approach_graph_runs (
  id                INTEGER PRIMARY KEY,
  ticket_id         INTEGER NOT NULL REFERENCES tickets(id),
  stage_key         TEXT NOT NULL CHECK (stage_key = 'impl'),
  stage_attempt     INTEGER NOT NULL,
  approach_id       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN (
    'planning','awaiting-confirmation','running','draining','blocked',
    'completed-awaiting-impl-marker','closed','stale','cancelled')),
  planner_run_count INTEGER NOT NULL DEFAULT 0,
  expert_run_count  INTEGER NOT NULL DEFAULT 0,
  node_run_count    INTEGER NOT NULL DEFAULT 0,
  replan_count      INTEGER NOT NULL DEFAULT 0,
  blocked_reason    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT,
  completed_at      TEXT,
  workspace_bytes   INTEGER NOT NULL DEFAULT 0,
  active_processes  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ticket_id, stage_attempt)
);
CREATE INDEX IF NOT EXISTS idx_graph_runs_ticket ON approach_graph_runs(ticket_id, id);
CREATE TABLE IF NOT EXISTS approach_planner_runs (
  id                    INTEGER PRIMARY KEY,
  graph_run_id          INTEGER NOT NULL REFERENCES approach_graph_runs(id),
  target_revision_number INTEGER,
  planner_run_number    INTEGER NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('bootstrap','replan')),
  status                TEXT NOT NULL CHECK (status IN (
    'ready','launching','running','submitted','blocked','launch-unknown','stale','cancelled')),
  profile               TEXT,
  provider              TEXT,
  model                 TEXT,
  effort                TEXT,
  prompt_hash           TEXT,
  compile_attempt       INTEGER NOT NULL DEFAULT 0,
  launch_attempt        INTEGER NOT NULL DEFAULT 0,
  generation            TEXT,
  process_run_id        INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  owner_nonce           TEXT,
  capability_hash       TEXT,
  graph_snapshot_id     TEXT,
  artifact_snapshot_id  TEXT,
  reason                TEXT,
  started_at            TEXT,
  submitted_at          TEXT,
  ended_at              TEXT,
  UNIQUE (graph_run_id, planner_run_number)
);
CREATE INDEX IF NOT EXISTS idx_planner_runs_run ON approach_planner_runs(graph_run_id, id);
CREATE TABLE IF NOT EXISTS approach_graph_revisions (
  id                        INTEGER PRIMARY KEY,
  graph_run_id              INTEGER NOT NULL REFERENCES approach_graph_runs(id),
  revision_number           INTEGER NOT NULL,
  canonical_graph           TEXT NOT NULL,
  fingerprint               TEXT NOT NULL,
  planner_graph_snapshot_id TEXT,
  planner_artifact_snapshot_id TEXT,
  command_fingerprints      TEXT,
  resource_domains          TEXT,
  supersedes_revision_id    INTEGER,
  reason                    TEXT,
  status                    TEXT NOT NULL CHECK (status IN ('active','draining','superseded','completed')),
  created_at                TEXT NOT NULL,
  superseded_at             TEXT,
  UNIQUE (graph_run_id, revision_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_revisions_active
  ON approach_graph_revisions(graph_run_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS approach_node_runs (
  id                       INTEGER PRIMARY KEY,
  graph_run_id             INTEGER NOT NULL REFERENCES approach_graph_runs(id),
  revision_id              INTEGER NOT NULL REFERENCES approach_graph_revisions(id),
  node_id                  TEXT NOT NULL,
  node_kind                TEXT NOT NULL,
  visit_number             INTEGER NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN (
    'ready','waiting-resource','launching','running','completing','integrating',
    'completed','blocked','failed-to-launch','launch-unknown','termination-unknown',
    'output-artifact-missing','artifact-unsafe','stale','cancelled')),
  outcome                  TEXT,
  effective_outcome        TEXT,
  reason                   TEXT,
  failure_category         TEXT,
  profile                  TEXT,
  provider                 TEXT,
  model                    TEXT,
  effort                   TEXT,
  prompt_hash              TEXT,
  launch_attempt           INTEGER NOT NULL DEFAULT 0,
  generation               TEXT,
  process_run_id           INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  owner_nonce              TEXT,
  capability_hash          TEXT,
  instruction_artifact_id  INTEGER,
  input_artifact_id        INTEGER,
  output_artifact_id       INTEGER,
  change_set_id            TEXT,
  started_at               TEXT,
  ended_at                 TEXT,
  base_heads               TEXT,
  UNIQUE (revision_id, node_id, visit_number)
);
CREATE INDEX IF NOT EXISTS idx_node_runs_revision ON approach_node_runs(revision_id, id);
CREATE TABLE IF NOT EXISTS approach_graph_tokens (
  id                    INTEGER PRIMARY KEY,
  revision_id           INTEGER NOT NULL REFERENCES approach_graph_revisions(id),
  source_node_run_id    INTEGER,
  is_entry              INTEGER NOT NULL DEFAULT 0 CHECK (is_entry IN (0,1)),
  edge_id               TEXT NOT NULL,
  destination_node_id   TEXT NOT NULL,
  destination_end       INTEGER NOT NULL DEFAULT 0 CHECK (destination_end IN (0,1)),
  fork_instance         INTEGER NOT NULL DEFAULT 0,
  fork_lineage          TEXT,
  fork_instance_id      TEXT,
  status                TEXT NOT NULL CHECK (status IN ('pending','claimed','consumed','cancelled')),
  claiming_node_run_id  INTEGER,
  consuming_node_run_id INTEGER,
  created_at            TEXT NOT NULL,
  consumed_at           TEXT,
  UNIQUE (source_node_run_id, edge_id, fork_instance)
);
CREATE INDEX IF NOT EXISTS idx_graph_tokens_revision ON approach_graph_tokens(revision_id, status);
CREATE TABLE IF NOT EXISTS approach_artifact_instances (
  id                      INTEGER PRIMARY KEY,
  graph_run_id            INTEGER NOT NULL REFERENCES approach_graph_runs(id),
  revision_id             INTEGER,
  artifact_id             TEXT NOT NULL,
  producer_planner_run_id INTEGER,
  producer_node_run_id    INTEGER,
  fork_lineage            TEXT,
  snapshot_path           TEXT NOT NULL,
  sha256                  TEXT NOT NULL,
  media_type              TEXT NOT NULL,
  byte_size               INTEGER NOT NULL,
  sensitivity             TEXT,
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_instances_run ON approach_artifact_instances(graph_run_id, id);
CREATE TABLE IF NOT EXISTS approach_resource_leases (
  id                INTEGER PRIMARY KEY,
  graph_run_id      INTEGER NOT NULL REFERENCES approach_graph_runs(id),
  owner_node_run_id INTEGER NOT NULL REFERENCES approach_node_runs(id),
  physical_domain   TEXT NOT NULL,
  access_mode       TEXT NOT NULL,
  claimed_paths     TEXT,
  status            TEXT NOT NULL CHECK (status IN ('held','released','ambiguous-process')),
  acquired_at       TEXT NOT NULL,
  released_at       TEXT,
  UNIQUE (owner_node_run_id, physical_domain)
);
CREATE INDEX IF NOT EXISTS idx_resource_leases_domain ON approach_resource_leases(physical_domain, status);
CREATE TABLE IF NOT EXISTS approach_node_overrides (
  id            INTEGER PRIMARY KEY,
  graph_run_id  INTEGER NOT NULL REFERENCES approach_graph_runs(id),
  revision_id   INTEGER,
  node_id       TEXT,
  provider      TEXT,
  model         TEXT,
  effort        TEXT,
  profile       TEXT,
  kind          TEXT NOT NULL DEFAULT 'provider' CHECK (kind IN ('profile','provider','model','effort','prompt')),
  value         TEXT NOT NULL DEFAULT '',
  row_version   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_overrides_rev_node_kind
  ON approach_node_overrides(revision_id, node_id, kind);
CREATE INDEX IF NOT EXISTS idx_node_overrides_node ON approach_node_overrides(graph_run_id, node_id);
CREATE TABLE IF NOT EXISTS approach_node_deferrals (
  id            INTEGER PRIMARY KEY,
  graph_run_id  INTEGER NOT NULL REFERENCES approach_graph_runs(id),
  revision_id   INTEGER NOT NULL REFERENCES approach_graph_revisions(id),
  node_id       TEXT NOT NULL,
  reason        TEXT NOT NULL,
  wait_since    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (revision_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_node_deferrals_run ON approach_node_deferrals(graph_run_id, id);
`;

/**
 * v37's `approach_node_runs` rebuild (Slice 4 Task 2): SQLite cannot ALTER a
 * CHECK constraint, so the two new output-validation rest statuses
 * (`output-artifact-missing`, `artifact-unsafe`) require the standard
 * create → copy → drop → rename table rebuild. Columns and the UNIQUE index
 * are byte-identical in intent to schema.sql; only the status CHECK widens.
 * Exported so the interruption-atomicity test can drive the REAL step DDL.
 */
export const NODE_RUN_STATUSES_V37_DDL = `
CREATE TABLE approach_node_runs_v37 (
  id                       INTEGER PRIMARY KEY,
  graph_run_id             INTEGER NOT NULL REFERENCES approach_graph_runs(id),
  revision_id              INTEGER NOT NULL REFERENCES approach_graph_revisions(id),
  node_id                  TEXT NOT NULL,
  node_kind                TEXT NOT NULL,
  visit_number             INTEGER NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN (
    'ready','waiting-resource','launching','running','completing','integrating',
    'completed','blocked','failed-to-launch','launch-unknown','termination-unknown',
    'output-artifact-missing','artifact-unsafe','stale','cancelled')),
  outcome                  TEXT,
  effective_outcome        TEXT,
  reason                   TEXT,
  failure_category         TEXT,
  profile                  TEXT,
  provider                 TEXT,
  model                    TEXT,
  effort                   TEXT,
  prompt_hash              TEXT,
  launch_attempt           INTEGER NOT NULL DEFAULT 0,
  generation               TEXT,
  process_run_id           INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  owner_nonce              TEXT,
  capability_hash          TEXT,
  instruction_artifact_id  INTEGER,
  input_artifact_id        INTEGER,
  output_artifact_id       INTEGER,
  change_set_id            TEXT,
  started_at               TEXT,
  ended_at                 TEXT,
  UNIQUE (revision_id, node_id, visit_number)
);
INSERT INTO approach_node_runs_v37
  SELECT id, graph_run_id, revision_id, node_id, node_kind, visit_number, status,
         outcome, effective_outcome, reason, failure_category, profile, provider,
         model, effort, prompt_hash, launch_attempt, generation, process_run_id,
         owner_nonce, capability_hash, instruction_artifact_id, input_artifact_id,
         output_artifact_id, change_set_id, started_at, ended_at
  FROM approach_node_runs;
DROP TABLE approach_node_runs;
ALTER TABLE approach_node_runs_v37 RENAME TO approach_node_runs;
CREATE INDEX IF NOT EXISTS idx_node_runs_revision ON approach_node_runs(revision_id, id);
`;

/**
 * v53's `recovery_rounds` rebuild (Task 1A, recovery-round-exhaustion): SQLite
 * cannot ALTER a CHECK constraint, so widening `status` with 'refused'/'reset'
 * and adding `CHECK (round <= max_rounds)` require the standard create → copy
 * → drop → rename table rebuild, mirroring v37's `approach_node_runs` shape.
 * `episode` is new (byte-identical in intent to schema.sql's column) and
 * backfills to 1 for every existing row — per-stage episode history is not
 * derivable from stored rows, and 1 is the truthful "one episode so far"
 * answer.
 *
 * The copy's SELECT also REPAIRS two real corruptions (ticket 46) so the new
 * CHECK does not reject them on the way in — this makes already-stored data
 * internally consistent, not "backfilling data migrations can't derive"
 * (`docs/arch/store-and-schema.md`):
 *  - `round > max_rounds` (rows 11 and 16): repaired by RAISING the snapshot to
 *    `max_rounds = round`, never by lowering `round`. `round` is identity — it
 *    is in the unique index — and ticket 46 holds both (round 5, max 5) and
 *    (round 6, max 5) for one stage, so clamping the ordinal collides them onto
 *    round 5 and the migration throws on the index, taking the whole registry
 *    down with it. The budget snapshot is the safe half to move, and the
 *    relabelling below is what actually records "this round never had a budget".
 *  - a clamped round whose status was 'exhausted' is relabelled 'refused' —
 *    "born with no budget" is a different fact from "spent the budget", and
 *    T1A's migration is the ONLY writer of 'refused' (no live writer exists
 *    or should exist once T1B's episode-scoped numbering lands, per the plan).
 * `fix_process_run_id`, every timestamp, and every other column are carried
 * through unchanged.
 *
 * Exported so the interruption-atomicity test can drive the REAL step DDL.
 */
export const RECOVERY_ROUNDS_V53_DDL = `
CREATE TABLE recovery_rounds_v53 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  source_stage TEXT NOT NULL CHECK (source_stage IN ('uat','review')),
  source_process_id TEXT NOT NULL,
  source_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  source_process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  trigger_kind TEXT NOT NULL,
  trigger_detail TEXT NOT NULL,
  episode INTEGER NOT NULL DEFAULT 1,
  round INTEGER NOT NULL,
  max_rounds INTEGER NOT NULL,
  fix_process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  uat_revalidation_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  review_revalidation_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','fixing','revalidating','passed','failed','exhausted','interrupted','refused','reset')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  interrupt_count INTEGER NOT NULL DEFAULT 0,
  CHECK (round <= max_rounds)
);
INSERT INTO recovery_rounds_v53
  SELECT id, ticket_id, source_stage, source_process_id, source_stage_run_id,
         source_process_run_id, trigger_kind, trigger_detail,
         1 AS episode,
         round,
         CASE WHEN round > max_rounds THEN round ELSE max_rounds END AS max_rounds,
         fix_process_run_id, uat_revalidation_stage_run_id,
         review_revalidation_stage_run_id,
         CASE WHEN round > max_rounds AND status = 'exhausted' THEN 'refused'
              ELSE status END AS status,
         started_at, ended_at, interrupt_count
  FROM recovery_rounds;
DROP TABLE recovery_rounds;
ALTER TABLE recovery_rounds_v53 RENAME TO recovery_rounds;
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_round
  ON recovery_rounds(ticket_id, source_stage, episode, round);
`;

/**
 * v53's `stages` rebuild (Task 1A): SQLite cannot ALTER a CHECK constraint, so
 * adding `CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >=
 * started_at)` (Issue #4's root corruption class) requires the standard
 * create → copy → drop → rename rebuild. `stages` carries no FK of its own
 * and — per `PRAGMA foreign_key_list` reasoning over schema.sql — nothing
 * else declares a FK referencing `stages` (its PRIMARY KEY is the composite
 * `(ticket_id, stage_key)`, never a FK target), so the drop/rename window
 * cannot orphan a foreign row; `foreign_keys = OFF` is suspended only because
 * it must be for ANY rebuild inside a transaction, matching v37.
 *
 * The copy's SELECT REPAIRS the one real corruption (ticket 46's uat row) so
 * the new CHECK does not reject it: `ended_at < started_at` is clamped to
 * `ended_at = started_at`. The corruption is a stale end stamp inherited from
 * a DIFFERENT run (entryPatch's running-branch omission, fixed by T1B), so
 * the start is the only defensible bound — this makes already-stored data
 * internally consistent, not deriving new information.
 *
 * Exported so the interruption-atomicity test can drive the REAL step DDL.
 */
export const STAGES_V53_DDL = `
CREATE TABLE stages_v53 (
  ticket_id     INTEGER NOT NULL,
  stage_key     TEXT NOT NULL,
  status        TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 0,
  verdict       TEXT,
  artifact_path TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  blocked_kind   TEXT,
  blocked_reason TEXT,
  blocked_at     TEXT,
  PRIMARY KEY (ticket_id, stage_key),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
INSERT INTO stages_v53
  SELECT ticket_id, stage_key, status, attempt, verdict, artifact_path, started_at,
         CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL AND ended_at < started_at
              THEN started_at ELSE ended_at END AS ended_at,
         blocked_kind, blocked_reason, blocked_at
  FROM stages;
DROP TABLE stages;
ALTER TABLE stages_v53 RENAME TO stages;
`;

/**
 * v39's workspace-ledger table (Slice 5 Task 1). Byte-identical in intent to
 * the schema.sql block it mirrors; `db.test.ts` pins that with a `toContain`.
 * The two v39 COLUMNS (`approach_graph_runs.workspace_bytes`,
 * `approach_node_runs.base_heads`) already live inside `GRAPH_MIGRATION_DDL`
 * above for fresh DBs — this step's guarded ALTERs bring legacy DBs up.
 */
export const GRAPH_WORKSPACE_MIGRATION_DDL = `
CREATE TABLE IF NOT EXISTS approach_graph_workspaces (
  id             INTEGER PRIMARY KEY,
  graph_run_id   INTEGER NOT NULL REFERENCES approach_graph_runs(id),
  node_run_id    INTEGER NOT NULL REFERENCES approach_node_runs(id),
  repo_name      TEXT NOT NULL,
  cwd            TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_workspaces_run ON approach_graph_workspaces(graph_run_id, id);
CREATE INDEX IF NOT EXISTS idx_graph_workspaces_node ON approach_graph_workspaces(node_run_id, id);
`;

/**
 * v40's deferral ledger (Slice 5 Task 3). Byte-identical in intent to the
 * schema.sql block it mirrors; `db.test.ts` pins that with a `toContain`. The
 * `approach_graph_runs.active_processes` COLUMN already lives inside
 * `GRAPH_MIGRATION_DDL` above for fresh DBs — this step's guarded ALTER
 * brings legacy DBs up.
 */
export const GRAPH_DEFERRAL_MIGRATION_DDL = `
CREATE TABLE IF NOT EXISTS approach_node_deferrals (
  id            INTEGER PRIMARY KEY,
  graph_run_id  INTEGER NOT NULL REFERENCES approach_graph_runs(id),
  revision_id   INTEGER NOT NULL REFERENCES approach_graph_revisions(id),
  node_id       TEXT NOT NULL,
  reason        TEXT NOT NULL,
  wait_since    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (revision_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_node_deferrals_run ON approach_node_deferrals(graph_run_id, id);
`;


export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  if (current < 1) {
    db.exec(readSchema());
  }

  if (current < 2) {
    const existing = ticketColumns(db);
    for (const col of V2_TICKET_COLUMNS) {
      if (!existing.has(col)) {
        db.exec(`ALTER TABLE tickets ADD COLUMN ${col} TEXT`);
      }
    }
  }

  if (current < 3) {
    // v3 adds the soft-delete column. Fresh DBs already carry it (schema.sql);
    // guard so the ALTER only runs for a legacy DB being upgraded.
    if (!ticketColumns(db).has('archived_at')) {
      db.exec('ALTER TABLE tickets ADD COLUMN archived_at TEXT');
    }
  }

  if (current < 4) {
    // v4 adds the single-subagent selection column. Fresh DBs already carry
    // it (schema.sql); guard so the ALTER only runs for a legacy DB being
    // upgraded.
    if (!ticketColumns(db).has('agent')) {
      db.exec('ALTER TABLE tickets ADD COLUMN agent TEXT');
    }
  }

  if (current < 5) {
    // v5 adds the per-ticket model column. Fresh DBs already carry it
    // (schema.sql); guard so the ALTER only runs for a legacy DB being upgraded.
    if (!ticketColumns(db).has('model')) {
      db.exec('ALTER TABLE tickets ADD COLUMN model TEXT');
    }
  }

  if (current < 6) {
    // v6 adds project scoping. The `projects` table is created with IF NOT
    // EXISTS so it is a no-op on a fresh DB (schema.sql already made it), and
    // the ALTER is guarded the same way as every earlier column step.
    //
    // Existing tickets keep `project_id IS NULL`. They are NOT backfilled here —
    // a migration cannot know which project they belong to. The host adopts them
    // on first bind (see `adoptUnassignedTickets`), which is correct while only
    // one project exists and is the point at which a project id is known.
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id            INTEGER PRIMARY KEY,
        slug          TEXT NOT NULL UNIQUE,
        name          TEXT,
        root_path     TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    if (!ticketColumns(db).has('project_id')) {
      db.exec('ALTER TABLE tickets ADD COLUMN project_id INTEGER');
    }
    // Scoped list queries all filter on project_id; without this every sidebar
    // refresh is a full table scan once several projects share the DB.
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id)');
  }

  if (current < 7) {
    // v7 adds per-gate evidence. Fresh DBs already carry it (schema.sql), so the
    // IF NOT EXISTS makes this a no-op there and purely additive on a legacy DB.
    // Nothing on `stages` is touched.
    //
    // NOT backfilled, and cannot be: `stages` keeps only the LAST run's verdict,
    // and pre-v53 artifact filenames were single-slot (`review-ticket-<id>.log`),
    // so every retry overwrote its predecessor's log. v53 keys the log path on
    // `stage_run_id` (`review-ticket-<id>-<runId>.log`), but past runs' logs are
    // gone — there is no source from which past gate results could be derived.
    // Inventing rows here would be exactly the inference the no-inference
    // guarantee forbids. In-flight tickets show no recorded gates until their
    // next gate run.
    db.exec(`
      CREATE TABLE IF NOT EXISTS gate_runs (
        id            INTEGER PRIMARY KEY,
        ticket_id     INTEGER NOT NULL,
        stage_key     TEXT NOT NULL,
        attempt       INTEGER NOT NULL,
        run_at        TEXT NOT NULL,
        gate_name     TEXT NOT NULL,
        exit_code     INTEGER,
        started_at    TEXT,
        ended_at      TEXT
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_gate_runs_ticket ON gate_runs(ticket_id, stage_key, id)',
    );
  }

  if (current < 8) {
    // v8 records the phases an agent REPORTED entering during a marker stage.
    // Fresh DBs already carry it (schema.sql), so the IF NOT EXISTS makes this a
    // no-op there and purely additive on a legacy DB. Nothing on `stages` is
    // touched — a phase is an append-only event, not stage state.
    //
    // NOT backfilled, and cannot be: nothing was ever written down about past
    // phase activity — no column, no log, no artifact — so there is no source to
    // derive it from. Synthesising marks would assert that phases ran when karst
    // has no evidence they did, which is exactly the inference the no-inference
    // guarantee forbids. In-flight tickets simply show no reported phases until
    // their agent fires its next marker; absence is not evidence of absence.
    db.exec(`
      CREATE TABLE IF NOT EXISTS phase_marks (
        id            INTEGER PRIMARY KEY,
        ticket_id     INTEGER NOT NULL,
        stage_key     TEXT NOT NULL,
        attempt       INTEGER NOT NULL,
        phase_name    TEXT NOT NULL,
        marked_at     TEXT NOT NULL
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_phase_marks_ticket ON phase_marks(ticket_id, stage_key, id)',
    );
  }

  if (current < 9) {
    // v9 records whether each shipped branch still merges into its base. Fresh DBs
    // already carry it (schema.sql), so the IF NOT EXISTS makes this a no-op there
    // and purely additive on a legacy DB. Nothing on `stages` or `prs` is touched.
    //
    // NOT backfilled, and cannot be: mergeability is a live property of two refs
    // that have both moved since. Computing it here would need a fetch per repo
    // from inside a migration, and writing down today's answer as though it were
    // the answer at ship time is exactly the inference the no-inference guarantee
    // forbids. Already-shipped tickets simply show no merge check until their next
    // ship — absence renders as nothing, never as "clean".
    db.exec(`
      CREATE TABLE IF NOT EXISTS merge_checks (
        ticket_id     INTEGER NOT NULL,
        repo          TEXT NOT NULL,
        state         TEXT NOT NULL,
        files         TEXT NOT NULL,
        reason        TEXT,
        head_sha      TEXT,
        base_sha      TEXT,
        base_ref      TEXT,
        checked_at    TEXT NOT NULL,
        PRIMARY KEY (ticket_id, repo)
      )
    `);
  }

  if (current < 10) {
    // v10 renames `service` -> `repo` on the three runtime tables, to match
    // repositories becoming the primary entity. The values never changed
    // meaning — they were always manifest keys — so this is a pure rename with
    // nothing to backfill and no data at risk.
    //
    // This is the first non-additive step in this file. `ALTER TABLE ... RENAME
    // COLUMN` rewrites the PRIMARY KEY on baseline_refs for us. The guard reads
    // the CURRENT columns, so a fresh DB (already `repo` from schema.sql) skips
    // it and a re-run is a no-op — same idempotence contract as every ADD COLUMN
    // step above.
    for (const table of V10_RENAMED_TABLES) {
      if (tableColumns(db, table).has('service')) {
        db.exec(`ALTER TABLE ${table} RENAME COLUMN service TO repo`);
      }
    }
  }

  if (current < 11) {
    // v11 adds the worktree-archive registry. Fresh DBs already carry it
    // (schema.sql), so IF NOT EXISTS makes this a no-op there and purely additive
    // on a legacy DB. Nothing is backfilled: an archive is a git ref that only
    // exists once a worktree is actually archived — there is nothing to derive.
    db.exec(`
      CREATE TABLE IF NOT EXISTS worktree_archives (
        id              INTEGER PRIMARY KEY,
        ticket_id       INTEGER NOT NULL,
        repo            TEXT NOT NULL,
        path            TEXT NOT NULL,
        branch          TEXT NOT NULL,
        base_ref        TEXT,
        archive_ref     TEXT NOT NULL,
        method          TEXT NOT NULL,
        reclaimed_bytes INTEGER,
        archived_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_worktree_archives_ticket ON worktree_archives(ticket_id, path)',
    );
  }

  if (current < 12) {
    // v12 adds the per-ticket agent-provider override (§ agent core selection).
    // Fresh DBs already carry it (schema.sql); guard so the ALTER only runs for
    // a legacy DB being upgraded. NULL = inherit manifest.agentProvider, same
    // "inherit" convention as the v5 model column.
    const cols = ticketColumns(db);
    if (cols.size > 0 && !cols.has('agent_provider')) {
      db.exec('ALTER TABLE tickets ADD COLUMN agent_provider TEXT');
    }
  }

  if (current < 13) {
    // v13 tags a captured session with the agent core that minted it. A session
    // id only resolves inside the CLI that created it, so an untagged id handed
    // to another core makes `--resume` fail on launch. Nothing is backfilled:
    // the provider of an already-captured session cannot be derived, and a
    // guess would reintroduce exactly the crash this column prevents — a NULL
    // simply means "never resume this one" (see resumeDecision.ts).
    const cols = ticketColumns(db);
    if (cols.size > 0 && !cols.has('session_provider')) {
      db.exec('ALTER TABLE tickets ADD COLUMN session_provider TEXT');
    }
  }

  if (current < 14) {
    // v14 adds parent_ticket_id, linking a follow-up ticket to the completed
    // ticket it continues work from (§ continue work on a ticket). Fresh DBs
    // already carry it (schema.sql); guard so the ALTER only runs for a legacy
    // DB being upgraded. NULL = not a follow-up.
    const cols = ticketColumns(db);
    if (cols.size > 0 && !cols.has('parent_ticket_id')) {
      db.exec('ALTER TABLE tickets ADD COLUMN parent_ticket_id INTEGER');
    }
    if (cols.size > 0) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_ticket_id)');
    }
  }

  if (current < 15) {
    // v15 adds the per-ticket conventional-commit type feeding `{type}` in the
    // branch/commit/PR templates. Purely additive and guarded on the CURRENT
    // columns, so a fresh DB (already `type` from schema.sql) skips it. Nothing is
    // backfilled: a pre-v15 ticket carries no type to derive, and NULL already
    // means "inherit conventions.defaultType".
    //
    // `tableColumns` is empty both for "table absent" and "table without the
    // column", so test the table first — a partial legacy DB (one that never had
    // `tickets`) must skip the step, not fail the open.
    const cols = ticketColumns(db);
    if (cols.size > 0 && !cols.has('type')) {
      db.exec('ALTER TABLE tickets ADD COLUMN type TEXT');
    }
  }

  if (current < 16) {
    // v16 adds the PR metadata the ship stage renders beside a PR: its source and
    // target branch, when it was opened, when it was merged, and its comments.
    // Purely additive and guarded on the CURRENT columns, so a fresh DB (already
    // carrying them from schema.sql) skips every ALTER and a re-open is a no-op.
    //
    // Nothing is backfilled — these facts live on GitHub, not in the registry, and
    // a migration cannot reach the network. NULL means "never probed", which the
    // PR panel renders as absent rather than as a blank or an invented value; the
    // next `syncPrStatuses` sweep fills them in.
    const cols = tableColumns(db, 'prs');
    if (cols.size > 0) {
      for (const col of V16_PR_COLUMNS) {
        if (!cols.has(col)) db.exec(`ALTER TABLE prs ADD COLUMN ${col} TEXT`);
      }
    }
  }

  if (current < 17) {
    // v17 gives a gate stage a durable "karst could not ask" state. Purely
    // additive and guarded on the CURRENT columns, so a fresh DB (already carrying
    // them from schema.sql) skips the step and a re-open is a no-op. Nothing is
    // backfilled: absence IS "not blocked", which is the correct reading of every
    // existing row.
    const cols = tableColumns(db, 'stages');
    if (cols.size > 0) {
      if (!cols.has('blocked_kind')) db.exec('ALTER TABLE stages ADD COLUMN blocked_kind TEXT');
      if (!cols.has('blocked_reason')) db.exec('ALTER TABLE stages ADD COLUMN blocked_reason TEXT');
      if (!cols.has('blocked_at')) db.exec('ALTER TABLE stages ADD COLUMN blocked_at TEXT');
    }
  }

  if (current < 18) {
    // v18 adds prompt attachments (images/video). Purely additive and a
    // CREATE TABLE IF NOT EXISTS, so a fresh DB (already carrying it from
    // schema.sql) skips it and a re-open is a no-op.
    //
    // Nothing is backfilled — there are no pre-v18 attachments to derive. The
    // bytes live on disk under <globalStorage>/attachments/, which a migration
    // has no business reaching into; the table indexes them, and the host owns
    // the directory's lifecycle.
    db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_attachments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id     INTEGER NOT NULL,
        kind          TEXT NOT NULL,
        stored_name   TEXT NOT NULL,
        original_name TEXT NOT NULL,
        byte_size     INTEGER NOT NULL,
        created_at    TEXT NOT NULL,
        operation_token TEXT,
        detach_token    TEXT
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket ON ticket_attachments(ticket_id, id)',
    );
  }

  // The attachment table was strengthened before release. A development registry
  // may already report a current user_version while carrying the earlier table
  // (it shipped as v17 before the UAT stage claimed that number), so repair the
  // CURRENT shape outside the version gate instead of stranding it without the
  // conflict target the atomic attachment upsert requires.
  const repairAttachments = db.transaction(() => {
    const attachmentCols = tableColumns(db, 'ticket_attachments');
    if (attachmentCols.size === 0) return;
    if (!attachmentCols.has('operation_token')) {
      db.exec('ALTER TABLE ticket_attachments ADD COLUMN operation_token TEXT');
    }
    if (!attachmentCols.has('detach_token')) {
      db.exec('ALTER TABLE ticket_attachments ADD COLUMN detach_token TEXT');
    }
    // Pre-index builds could race two identical rows into a development DB.
    // They reference the same content-addressed file, so retaining the oldest
    // row restores the specified no-duplicate-tile model without losing bytes.
    db.exec(`
      DELETE FROM ticket_attachments
      WHERE id NOT IN (
        SELECT MIN(id) FROM ticket_attachments GROUP BY ticket_id, stored_name
      )
    `);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_attachments_ticket_stored_name ON ticket_attachments(ticket_id, stored_name)',
    );
  });
  repairAttachments();

  if (current < 19) {
    // v19 adds the append-only token_usage table plus its aggregation indexes
    // (§ token consumption stats). A whole new table, so the step is the same
    // DDL as schema.sql rather than an ALTER, and every statement is IF NOT
    // EXISTS — a fresh DB (already carrying it) and a re-open are both no-ops.
    //
    // Nothing is backfilled. Token counts live in the provider's response to a
    // call that already happened and was never captured; a migration cannot
    // reach them, and inventing them would put fabricated spend in the totals.
    // History starts at the upgrade, and an empty range renders as the view's
    // empty state rather than as zero spend.
    db.exec(TOKEN_USAGE_DDL);
  }

  if (current < 20) {
    // v20 adds the `merge` stage between ship and done (workflow/graph.ts), so
    // every existing ticket needs the row the create path now seeds for it.
    // Without it `setStage` — an UPDATE, by single-writer design — silently
    // writes nothing and `transition` throws "ticket N has no stage 'merge'"
    // the first time a ticket ships.
    //
    // Seeded `pending` with a NULL `started_at`, which is exactly "never
    // entered": `deriveStageCurrent` skips such a row, so a ticket already
    // sitting at `done` stays there and is NOT walked back to an unmerged
    // state it has no evidence for. Migrations do not backfill what they
    // cannot derive, and whether a long-shipped PR actually landed is a
    // question only gh can answer — `prSync` asks it on the next tick.
    //
    // Guarded on the tables actually being there, like every other step: a
    // partial registry (a legacy DB carrying only some of the schema) must
    // upgrade rather than fault, and a `stages`-less DB has no ticket to seed a
    // row for anyway.
    if (tableColumns(db, 'stages').size > 0 && tableColumns(db, 'tickets').size > 0) {
      db.exec(
        `INSERT INTO stages (ticket_id, stage_key, status, attempt)
           SELECT t.id, 'merge', 'pending', 0
             FROM tickets t
            WHERE NOT EXISTS (SELECT 1 FROM stages s
                               WHERE s.ticket_id = t.id AND s.stage_key = 'merge')`,
      );
    }
  }

  // The servers.cwd step cannot be version-gated, and repairing the CURRENT
  // shape outside the gate is deliberate — the same reason the attachment-table
  // repair above runs ungated. v21 was RENUMBERED before release: it first
  // shipped as the gate_runs invocation-identity columns in a build whose
  // SCHEMA_VERSION was 22, and only afterwards became this step (SCHEMA_VERSION
  // 23, gate_runs moved to v22). A registry stamped by the older build reports
  // user_version = 22 — not < 21 — so the gated ALTER would be skipped forever
  // and `servers` would stay without `cwd` while the DB claims to be current;
  // every path that reads it (the archive's pre-removal server scan first among
  // them) then dies with "no such column: cwd" (869efu319).
  //
  // Not backfilled, and deliberately not guessed: `repo` is a repository NAME
  // while worktrees are keyed by PATH, and several repository entries may share
  // one worktree — the mapping is not derivable from the registry. A NULL cwd
  // reads as "unknown" everywhere it is consumed, so a legacy row is never
  // reaped on a guess.
  const serverCols = tableColumns(db, 'servers');
  if (serverCols.size > 0 && !serverCols.has('cwd')) {
    db.exec('ALTER TABLE servers ADD COLUMN cwd TEXT');
  }

  if (current < 22) {
    // v22 adds the invocation-identity columns to `gate_runs` (repo/command/args)
    // so review's R7 ("did I ask a question UAT didn't") can compare on what
    // actually ran instead of the display name alone. Guarded like every other
    // column addition: a fresh DB already carries them via schema.sql, and this
    // only fires for a legacy DB being upgraded.
    //
    // NOTHING IS BACKFILLED. A pre-v21 row genuinely does not know what argv
    // produced it — that information was never captured — and inventing one
    // would make R7 compare against a guess rather than an absence. Every
    // reader treats a NULL identity as "no identity", never as a match or a
    // mismatch it can assert with confidence.
    const gateRunCols = tableColumns(db, 'gate_runs');
    if (gateRunCols.size > 0) {
      for (const col of V21_GATE_RUN_COLUMNS) {
        if (!gateRunCols.has(col)) {
          db.exec(`ALTER TABLE gate_runs ADD COLUMN ${col} TEXT`);
        }
      }
    }
  }

  if (current < 23) {
    // v23 adds review's Lane B evidence table (§6.7 `review_findings`) —
    // structured findings an agent reports about a ticket's diff, append-only
    // like gate_runs and phase_marks. A whole new table, so the step is the
    // same DDL as schema.sql rather than an ALTER, and every statement is IF
    // NOT EXISTS — a fresh DB (already carrying it) and a re-open are both
    // no-ops.
    //
    // Nothing is backfilled. There are no historical findings to derive: no
    // prior karst ever asked an agent this question or recorded an answer, so
    // an in-flight or already-reviewed ticket simply shows none until its next
    // review run.
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_findings (
        id          INTEGER PRIMARY KEY,
        ticket_id   INTEGER NOT NULL,
        attempt     INTEGER NOT NULL,
        run_at      TEXT NOT NULL,
        severity    TEXT NOT NULL,
        repo        TEXT NOT NULL,
        file        TEXT,
        line        INTEGER,
        title       TEXT NOT NULL,
        detail      TEXT NOT NULL,
        source      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_review_findings_ticket ON review_findings(ticket_id, run_at, id)',
    );
  }

  if (current < 24) {
    // v24 makes a gate disable-able for ONE ticket. Two columns, both nullable,
    // both guarded like every other column addition — a fresh DB already carries
    // them via schema.sql and a re-open is a no-op.
    //
    // `tickets.disabled_gates` is the override itself, shaped exactly like the
    // nullable `model`/`type` columns before it: absent means "no override,
    // run whatever resolution produced".
    //
    // `gate_runs.skipped` is deliberately NOT `exit_code IS NULL` reused. That
    // already means "the repo defines no such script (NOT a pass)"; a gate that
    // exists and was deliberately not run is a different fact, and conflating
    // them would make a disabled gate read as an absent script.
    //
    // NOTHING IS BACKFILLED. No historical row was ever skipped — the feature
    // did not exist — so NULL is the truthful answer, not 0 asserted as fact.
    const ticketCols = tableColumns(db, 'tickets');
    if (ticketCols.size > 0 && !ticketCols.has('disabled_gates')) {
      db.exec('ALTER TABLE tickets ADD COLUMN disabled_gates TEXT');
    }
    const gateRunCols24 = tableColumns(db, 'gate_runs');
    if (gateRunCols24.size > 0 && !gateRunCols24.has('skipped')) {
      db.exec('ALTER TABLE gate_runs ADD COLUMN skipped INTEGER');
    }
  }

  if (current < 25) {
    // v25 makes a gate run itself durable. Before this, evidence existed only
    // once the run FINISHED — so a host restart mid-run discarded every gate
    // result and every finding it had already paid for, and left a stage
    // reading `running` since a timestamp that belonged to a run which no
    // longer existed.
    //
    // The new table is opened at run entry and closed at its outcome; the new
    // `gate_runs.stage_run_id` ties each incrementally-written row back to the
    // invocation that produced it. Both are additive and guarded, so a fresh DB
    // (already carrying them via schema.sql) and a re-open are no-ops.
    //
    // NOTHING IS BACKFILLED. A historical gate_runs row cannot name a run that
    // was never recorded, and no past run's liveness can be reconstructed — a
    // synthesized `finished` row would assert exactly the fact this table exists
    // to stop being guessed at.
    db.exec(`
      CREATE TABLE IF NOT EXISTS stage_runs (
        id             INTEGER PRIMARY KEY,
        ticket_id      INTEGER NOT NULL,
        stage_key      TEXT NOT NULL,
        attempt        INTEGER NOT NULL,
        run_at         TEXT NOT NULL,
        status         TEXT NOT NULL,
        outcome        TEXT,
        manifest_hash  TEXT,
        pid            INTEGER,
        started_at     TEXT NOT NULL,
        ended_at       TEXT
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_stage_runs_ticket ON stage_runs(ticket_id, stage_key, id)',
    );
    const gateRunCols25 = tableColumns(db, 'gate_runs');
    if (gateRunCols25.size > 0 && !gateRunCols25.has('stage_run_id')) {
      db.exec('ALTER TABLE gate_runs ADD COLUMN stage_run_id INTEGER');
    }

    // v25 also retires the standalone `merge` stage (workflow/graph.ts) — its
    // logic is now an entry gate on `done`, resolved by `workflow/mergeGate.ts`'s
    // `resolveShipLanding`/`settleShipGate` at `ship` itself rather than at a
    // separate node. A ticket a prior build parked at `merge` has nowhere valid
    // left to sit, so it moves back to `ship`, blocked exactly like a fresh
    // unlanded ship would be.
    //
    // The block is a PLACEHOLDER, not a judgement: whether that ticket's PRs
    // have actually landed by now is answered by the same read a fresh ship
    // uses (`mergeGateState`), and duplicating that logic in raw SQL here would
    // be a second, driftable answer to the same question. The next PR/merge
    // sweep tick (`settleShipGates`, already running on a timer) re-checks it
    // for real and clears the block immediately if everything already landed.
    //
    // The orphaned `stage_key = 'merge'` rows are left in place — harmless,
    // unreferenced once `STAGE_KEYS` no longer includes `merge`, and a DELETE
    // would only destroy evidence for no behavioral gain.
    const ticketCols25 = tableColumns(db, 'tickets');
    const stageCols25 = tableColumns(db, 'stages');
    if (ticketCols25.size > 0 && stageCols25.size > 0) {
      const at = new Date().toISOString();
      db.transaction(() => {
        // Ensure a ship row exists for every ticket at merge before setting the
        // block — without this, a ticket whose ship row was manually deleted
        // would move to ship without the awaiting-merge block, and
        // settleShipGate would never pick it up (it requires the block).
        db.prepare(
          `INSERT OR IGNORE INTO stages (ticket_id, stage_key, status)
            SELECT id, 'ship', 'pending'
              FROM tickets WHERE stage_current = 'merge'`,
        ).run();
        db.prepare(
          `UPDATE stages
              SET status = 'passed',
                  blocked_kind = 'awaiting-merge',
                  blocked_reason = 'awaiting merge (re-checked after upgrade)',
                  blocked_at = ?
            WHERE stage_key = 'ship'
              AND ticket_id IN (SELECT id FROM tickets WHERE stage_current = 'merge')`,
        ).run(at);
        db.exec(`UPDATE tickets SET stage_current = 'ship' WHERE stage_current = 'merge'`);
      })();
    }
  }

  if (current < 26) {
    // v26 makes an inside-process invocation itself durable (gates, commit,
    // delivery-receipt, recovery…). Before this, a stage's processes were
    // rendered from evidence that only existed once work FINISHED — so an
    // execution whose host died mid-flight left no record of having run at all,
    // and the AI identity that resolved for it (agent/provider/model) was never
    // captured anywhere. This table is opened at process entry and closed at
    // its outcome, exactly like stage_runs (v25), with the same crash policy:
    // a superseded run is marked `stale`, never deleted.
    //
    // A whole new table, so the step is the same DDL as schema.sql rather than
    // an ALTER, and every statement is IF NOT EXISTS — a fresh DB (already
    // carrying it) and a re-open are both no-ops.
    //
    // NOTHING IS BACKFILLED. No prior karst recorded which process ran, with
    // which identity or pid — a synthesized row would assert exactly the facts
    // this table exists to stop being guessed at, and an invented identity
    // snapshot would be a lie written into the one column set whose whole job
    // is never to change.
    db.exec(`
      CREATE TABLE IF NOT EXISTS process_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        stage_key     TEXT NOT NULL,
        process_id    TEXT NOT NULL,
        attempt       INTEGER NOT NULL,
        stage_run_id  INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
        agent_name    TEXT,
        provider      TEXT,
        model         TEXT,
        pid           INTEGER,
        status        TEXT NOT NULL CHECK (status IN ('running','passed','failed','interrupted','stale')),
        result_kind   TEXT,
        artifact_path TEXT,
        started_at    TEXT NOT NULL,
        ended_at      TEXT
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_process_runs_ticket ON process_runs(ticket_id, stage_key, process_id, id)',
    );
  }

  if (current < 27) {
    // v27 links token usage and review findings to the process_runs row that
    // produced them (task 3), so the inside view can show ONE process's spend
    // and findings. Both columns are nullable with ON DELETE SET NULL: a call
    // or finding made outside a process stays unattributed, and deleting a run
    // must never destroy the evidence it merely attributes.
    //
    // Guarded like every other column addition: a fresh DB already carries them
    // via schema.sql, a re-open is a no-op, and a partial legacy DB without
    // `process_runs` skips the REFERENCES column (there is nothing to link to).
    //
    // NOTHING IS BACKFILLED. A pre-v27 row genuinely does not know which
    // process produced it — that information was never captured — and assigning
    // one to an invented run would be exactly the inference the no-inference
    // guarantee forbids. NULL reads as "no process", which is the truthful
    // answer for every existing row.
    const tokenCols27 = tableColumns(db, 'token_usage');
    if (tokenCols27.size > 0 && tableColumns(db, 'process_runs').size > 0) {
      if (!tokenCols27.has('process_run_id')) {
        db.exec(
          'ALTER TABLE token_usage ADD COLUMN process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL',
        );
      }
    }
    const findingCols27 = tableColumns(db, 'review_findings');
    if (findingCols27.size > 0 && tableColumns(db, 'process_runs').size > 0) {
      if (!findingCols27.has('process_run_id')) {
        db.exec(
          'ALTER TABLE review_findings ADD COLUMN process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL',
        );
      }
    }
    // Indexes only where the table exists — a partial legacy DB that never had
    // `token_usage` (a step-synthetic test schema) must upgrade, not fault.
    if (tokenCols27.size > 0) {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_token_usage_process ON token_usage(process_run_id, id)',
      );
    }
    if (findingCols27.size > 0) {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_review_findings_process ON review_findings(process_run_id, id)',
      );
    }
  }

  if (current < 28) {
    // v28 makes the interactive implementation itself durable: a STABLE
    // implementation run per impl pass (implementation_runs), one segment per
    // provider session inside it (implementation_segments), and the prepared
    // launches that produced them (session_launch_intents).
    //
    // A whole new table set, so the step is the same DDL as schema.sql rather
    // than ALTERs, and every statement is IF NOT EXISTS — a fresh DB (already
    // carrying it) and a re-open are both no-ops.
    //
    // NOTHING IS BACKFILLED. No prior karst recorded which provider session ran
    // when, or which launch prepared it — a synthesized run would assert exactly
    // the facts this table set exists to stop being guessed at. Pre-v28 tickets
    // show no implementation timeline until their next launch.
    db.exec(`
      CREATE TABLE IF NOT EXISTS implementation_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        process_run_id INTEGER NOT NULL UNIQUE REFERENCES process_runs(id) ON DELETE CASCADE,
        attempt       INTEGER NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('running','passed','interrupted')),
        started_at    TEXT NOT NULL,
        ended_at      TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_launch_intents (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        launch_id     TEXT NOT NULL UNIQUE,
        purpose       TEXT NOT NULL CHECK (purpose IN ('implementation','fix')),
        implementation_run_id INTEGER REFERENCES implementation_runs(id) ON DELETE CASCADE,
        process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
        provider      TEXT NOT NULL,
        model         TEXT,
        reason        TEXT NOT NULL,
        session_origin TEXT NOT NULL CHECK (session_origin IN ('new','resume','unknown')),
        provider_session_id TEXT,
        status        TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed','superseded')),
        created_at    TEXT NOT NULL,
        resolved_at   TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS implementation_segments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        implementation_run_id INTEGER NOT NULL REFERENCES implementation_runs(id) ON DELETE CASCADE,
        provider      TEXT NOT NULL,
        model         TEXT,
        provider_session_id TEXT,
        reason        TEXT,
        status        TEXT NOT NULL CHECK (status IN ('pending','running','closed','interrupted')),
        launch_intent_id INTEGER NOT NULL UNIQUE
                        REFERENCES session_launch_intents(id) ON DELETE CASCADE,
        started_at    TEXT,
        ended_at      TEXT
      )
    `);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_session_launch_pending ' +
        "ON session_launch_intents(ticket_id, purpose) WHERE status = 'pending'",
    );
    // Existing phase marks predate the run/segment vocabulary — the linkage is
    // left NULL, never backfilled, for the same reason every other attribution
    // column here stays NULL: the fact was never captured and a guess would be
    // a lie in the one column set whose job is attribution.
    const markCols28 = tableColumns(db, 'phase_marks');
    if (markCols28.size > 0 && tableColumns(db, 'implementation_runs').size > 0) {
      if (!markCols28.has('implementation_run_id')) {
        db.exec(
          'ALTER TABLE phase_marks ADD COLUMN implementation_run_id INTEGER REFERENCES implementation_runs(id) ON DELETE SET NULL',
        );
      }
      if (!markCols28.has('implementation_segment_id')) {
        db.exec(
          'ALTER TABLE phase_marks ADD COLUMN implementation_segment_id INTEGER REFERENCES implementation_segments(id) ON DELETE SET NULL',
        );
      }
    }
    // Token usage stays unattributed to a segment for every pre-v28 call (all
    // of them — Task 5 adds the measured ingestion seam that writes this).
    const tokenCols28 = tableColumns(db, 'token_usage');
    if (tokenCols28.size > 0 && tableColumns(db, 'implementation_segments').size > 0) {
      if (!tokenCols28.has('implementation_segment_id')) {
        db.exec(
          'ALTER TABLE token_usage ADD COLUMN implementation_segment_id INTEGER REFERENCES implementation_segments(id) ON DELETE SET NULL',
        );
      }
    }
    if (tokenCols28.size > 0) {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_token_usage_segment ON token_usage(implementation_segment_id, id)',
      );
    }
  }

  if (current < 29) {
    // v29 makes measured INTERACTIVE token observations durable (Task 5): the
    // cumulative samples provider bridges POST (interactive_usage_samples) and
    // the token_usage linkage of the delta rows computed from them. Samples are
    // persisted BEFORE their delta is calculated, so a host restart between
    // observations never loses the baseline decision.
    //
    // A whole new table, so the step is the same DDL as schema.sql rather than
    // an ALTER, and every statement is IF NOT EXISTS — a fresh DB (already
    // carrying it) and a re-open are both no-ops. `process_run_id` is NOT NULL:
    // an observation that cannot be attributed to a Karst process is dropped,
    // never stored against an invented one.
    //
    // NOTHING IS BACKFILLED. No prior karst ever measured an interactive
    // session's tokens — the channel did not exist — so a synthesized sample
    // would assert exactly the fact this table exists to stop being guessed at.
    // Pre-v29 ledger rows keep NULL `interactive_usage_sample_id`; the partial
    // unique index keeps each sample feeding at most one delta row.
    db.exec(`
      CREATE TABLE IF NOT EXISTS interactive_usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        process_run_id INTEGER NOT NULL REFERENCES process_runs(id) ON DELETE CASCADE,
        implementation_segment_id INTEGER REFERENCES implementation_segments(id) ON DELETE SET NULL,
        source_event_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens INTEGER,
        counter_epoch INTEGER NOT NULL DEFAULT 0,
        baseline_only INTEGER NOT NULL DEFAULT 0 CHECK (baseline_only IN (0,1)),
        observed_at TEXT NOT NULL
      )
    `);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_usage_event ' +
        'ON interactive_usage_samples(provider, provider_session_id, source_event_id)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_interactive_usage_segment ' +
        'ON interactive_usage_samples(implementation_segment_id, id)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_interactive_usage_process ' +
        'ON interactive_usage_samples(process_run_id, id)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_interactive_usage_provider_session ' +
        'ON interactive_usage_samples(provider, provider_session_id, id)',
    );
    const tokenCols29 = tableColumns(db, 'token_usage');
    if (tokenCols29.size > 0 && tableColumns(db, 'interactive_usage_samples').size > 0) {
      if (!tokenCols29.has('interactive_usage_sample_id')) {
        db.exec(
          'ALTER TABLE token_usage ADD COLUMN interactive_usage_sample_id INTEGER REFERENCES interactive_usage_samples(id) ON DELETE SET NULL',
        );
      }
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_interactive_sample ' +
          'ON token_usage(interactive_usage_sample_id) WHERE interactive_usage_sample_id IS NOT NULL',
      );
    }
  }

  if (current < 30) {
    // v30 persists CAUSAL recovery rounds (Task 6): one row per gate failure
    // that entered the fix loop, opened atomically with the failing verdict.
    //
    // A whole new table, so the step is the same DDL as schema.sql rather than
    // an ALTER, and every statement is IF NOT EXISTS — a fresh DB (already
    // carrying it) and a re-open are both no-ops. The linked
    // `session_launch_intents.recovery_round_id` column gives a pending Fix
    // launch a durable owner before its process run exists.
    //
    // NOTHING IS BACKFILLED. No prior karst recorded which failure sent a
    // ticket to fix, with which evidence and under which budget — a
    // synthesized round would assert exactly the facts this table exists to
    // stop being guessed at. A ticket already parked at fix when the upgrade
    // lands simply has no round until its next gate failure (the driver
    // falls back to the stages-attempt budget for it).
    db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        source_stage TEXT NOT NULL CHECK (source_stage IN ('uat','review')),
        source_process_id TEXT NOT NULL,
        source_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
        source_process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
        trigger_kind TEXT NOT NULL,
        trigger_detail TEXT NOT NULL,
        round INTEGER NOT NULL,
        max_rounds INTEGER NOT NULL,
        fix_process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
        uat_revalidation_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
        review_revalidation_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','fixing','revalidating','passed','failed','exhausted','interrupted')),
        started_at TEXT NOT NULL,
        ended_at TEXT
      )
    `);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_round ' +
        'ON recovery_rounds(ticket_id, source_stage, round)',
    );
    const intentCols30 = tableColumns(db, 'session_launch_intents');
    if (intentCols30.size > 0 && tableColumns(db, 'recovery_rounds').size > 0) {
      if (!intentCols30.has('recovery_round_id')) {
        db.exec(
          'ALTER TABLE session_launch_intents ADD COLUMN recovery_round_id INTEGER REFERENCES recovery_rounds(id) ON DELETE CASCADE',
        );
      }
    }
  }

  if (current < 31) {
    // v31 makes the UAT Tester process's structured observations durable
    // (Task 8): one row per observation, attributed to the Tester process run
    // that reported it. The same DDL as schema.sql, IF NOT EXISTS throughout —
    // a fresh DB (already carrying it) and a re-open are both no-ops.
    //
    // NOTHING IS BACKFILLED. No prior karst ran a Tester process or recorded
    // an observation — a synthesized row would assert exactly the facts this
    // table exists to stop being guessed at. Pre-v31 tickets show no Tester
    // observations until their next UAT run.
    db.exec(`
      CREATE TABLE IF NOT EXISTS uat_findings (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id      INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        process_run_id INTEGER NOT NULL REFERENCES process_runs(id) ON DELETE CASCADE,
        repo           TEXT,
        severity       TEXT NOT NULL,
        title          TEXT NOT NULL,
        file_path      TEXT,
        line           INTEGER,
        created_at     TEXT NOT NULL
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_uat_findings_ticket ON uat_findings(ticket_id, id)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_uat_findings_process ON uat_findings(process_run_id, id)',
    );
  }

  if (current < 32) {
    // v32 makes the SHIP SAGA durable (Task 9): one run per ship invocation,
    // one row per per-repo step, one typed ownership row per irreversible
    // operation persisted BEFORE the external side effect, and the commits
    // ship created (or found already present). A whole new table set, so the
    // step is the same DDL as schema.sql rather than ALTERs, and every
    // statement is IF NOT EXISTS — a fresh DB (already carrying it) and a
    // re-open are both no-ops.
    //
    // NOTHING IS BACKFILLED. No prior karst recorded a ship run, a repo step,
    // an operation intent, or a commit — a synthesized row would assert exactly
    // the facts this table set exists to stop being guessed at, and an invented
    // pre-state would authorize cleanup of something never owned. Pre-v32
    // tickets show no ship timeline until their next ship.
    db.exec(`
      CREATE TABLE IF NOT EXISTS ship_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ship_repo_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ship_run_id INTEGER NOT NULL REFERENCES ship_runs(id) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        step TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        pr_number INTEGER,
        existed_before_ship INTEGER,
        process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ship_operation_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ship_run_id INTEGER NOT NULL REFERENCES ship_runs(id) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        step TEXT NOT NULL,
        operation_key TEXT NOT NULL UNIQUE,
        pre_state_json TEXT NOT NULL,
        intent_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        prepared_at TEXT,
        applied_at TEXT,
        resolved_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ship_commits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ship_run_id INTEGER NOT NULL REFERENCES ship_runs(id) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        sha TEXT NOT NULL,
        message TEXT NOT NULL,
        origin TEXT NOT NULL
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_ship_run_ticket ON ship_runs(ticket_id, id)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_ship_step_run ON ship_repo_steps(ship_run_id, id)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_ship_commit_run ON ship_commits(ship_run_id, id)',
    );
    // Ownership linkage on the step rows. A partial/dev DB whose
    // `ship_repo_steps` predates the linkage column gets it appended — the
    // same guard pattern as every other column addition; a fresh DB created
    // with the column above skips the ALTER.
    const stepCols32 = tableColumns(db, 'ship_repo_steps');
    if (stepCols32.size > 0 && !stepCols32.has('operation_intent_id')) {
      db.exec(
        'ALTER TABLE ship_repo_steps ADD COLUMN operation_intent_id INTEGER REFERENCES ship_operation_intents(id) ON DELETE SET NULL',
      );
    }
  }

  if (current < 33) {
    // v33 makes the CONFIGURED Fix process identity durable on the prepared
    // launch: `session_launch_intents.agent_name` carries the resolved
    // `uat-fix`/`review-fix` agent name, so a closed-session Fix launch whose
    // SessionStart confirms later (possibly after a reload) opens its process
    // run with the identity that was resolved at resume time — later manifest
    // edits never rewrite history. Provider/model already ride the row.
    //
    // NOTHING IS BACKFILLED. No prior karst recorded which agent a prepared
    // launch was FOR — a NULL names the unknown, never an invented name.
    const intentCols33 = tableColumns(db, 'session_launch_intents');
    if (intentCols33.size > 0 && !intentCols33.has('agent_name')) {
      db.exec('ALTER TABLE session_launch_intents ADD COLUMN agent_name TEXT');
    }
  }

  if (current < 34) {
    // v34 records WHICH extension host opened a ship run (`ship_runs.pid`), so
    // an activation sweep can tell a ship that died with its host from one
    // another LIVE window is still executing. Without it a killed ship freezes
    // the ticket at `ship` reading `running` forever — no awaiting-merge block
    // for the merge sweep, no stage_runs row for the drive sweep, and no
    // button for a running row.
    //
    // Two recovery sweeps read it (both in `store/shipRuns.ts`):
    // `reconcileShipRuns` marks dead runs `interrupted` and parks the stage
    // `failed` (the one state that already has a recovery path: "Retry ship"),
    // while `listStrandedShipTickets` resumes the interrupted saga outright.
    // Same liveness posture as `stage_runs.pid` (v25): a pid is a recollection,
    // never a handle.
    //
    // NOTHING IS BACKFILLED. No prior karst recorded which process opened a
    // run — a NULL names the unknown, never an invented one: `reconcileShipRuns`
    // leaves a NULL-pid run strictly alone (absence of evidence is not evidence
    // it died), while the stranded-ship sweep treats it as stranded (absence of
    // evidence is not evidence of life) — a pre-v34 run can only be recovered
    // by re-running the saga built to be re-run.
    const shipRunCols34 = tableColumns(db, 'ship_runs');
    if (shipRunCols34.size > 0 && !shipRunCols34.has('pid')) {
      db.exec('ALTER TABLE ship_runs ADD COLUMN pid INTEGER');
    }
  }

  if (current < 35 || tableColumns(db, 'approach_graph_runs').size === 0) {
    // v35 adds the eight graph tables plus the `token_usage` graph-detachment
    // FKs (Slice 2, design "Persistence"). This is the ONE step wrapped in an
    // outer transaction (Decision 21): every other step autocommits and relies
    // on guards, but a graph migration interrupted midway must leave
    // `user_version` at 34 so the next open re-runs the same guarded steps.
    // `BEGIN IMMEDIATE` before the version read: the whole step — guarded DDL
    // and the version bump — commits together, or rolls back together.
    //
    // The outer guard is PRESENCE-based, not version-only: the graph tables
    // landed at v35 on this branch, but develop's v35 (the agent test driver)
    // shipped without them, so a registry migrated to v35 on develop must
    // still gain them here — `CREATE TABLE IF NOT EXISTS` makes the re-run a
    // no-op on a graph-shaped v35.
    db.exec('BEGIN IMMEDIATE');
    try {
      const inside = db.pragma('user_version', { simple: true }) as number;
      if (inside < 35 || tableColumns(db, 'approach_graph_runs').size === 0) {
        db.exec(GRAPH_MIGRATION_DDL);
        const tokenCols35 = tableColumns(db, 'token_usage');
        if (tokenCols35.size > 0 && !tokenCols35.has('approach_planner_run_id')) {
          db.exec(
            'ALTER TABLE token_usage ADD COLUMN approach_planner_run_id INTEGER ' +
              'REFERENCES approach_planner_runs(id) ON DELETE SET NULL',
          );
        }
        if (tokenCols35.size > 0 && !tokenCols35.has('approach_node_run_id')) {
          db.exec(
            'ALTER TABLE token_usage ADD COLUMN approach_node_run_id INTEGER ' +
              'REFERENCES approach_node_runs(id) ON DELETE SET NULL',
          );
        }
        db.pragma('user_version = 35');
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  if (current < 36) {
    // v36 records WHY a graph run blocked (`approach_graph_runs.blocked_reason`),
    // so the graph-aware recovery surface (Slice-3 Task 9) can name the
    // category — `resource-claim-violated` or `integration-conflict` — instead
    // of re-deriving it from scattered node rows. The completing pipeline
    // (Slice-3 Task 8) writes it in the same transaction that moves the run
    // `running → blocked`.
    //
    // NOTHING IS BACKFILLED. No prior karst recorded a block reason, and a
    // NULL names the unknown, never an invented category.
    const graphRunCols36 = tableColumns(db, 'approach_graph_runs');
    if (graphRunCols36.size > 0 && !graphRunCols36.has('blocked_reason')) {
      db.exec('ALTER TABLE approach_graph_runs ADD COLUMN blocked_reason TEXT');
    }
  }

  if (current < 37) {
    // v37 widens the `approach_node_runs` status CHECK with the two
    // output-validation rest statuses (Slice 4 Task 2). SQLite cannot alter
    // a CHECK constraint, so the table is REBUILT (create → copy → drop →
    // rename) inside one transaction, following v35's interruption-atomicity
    // pattern: a poisoned step rolls back and user_version stays 36.
    //
    // The guard reads the CURRENT table SQL — a fresh DB (schema.sql already
    // carries the widened CHECK) skips the rebuild entirely, and a re-run on
    // a migrated DB is a no-op. Foreign-key enforcement is suspended for the
    // swap (it cannot change inside a transaction); the rename restores the
    // name every FK clause references.
    const nodeRunsSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approach_node_runs'",
        )
        .get() as { sql: string } | undefined
    )?.sql;
    if (nodeRunsSql && !nodeRunsSql.includes('output-artifact-missing')) {
      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(NODE_RUN_STATUSES_V37_DDL);
          db.pragma('user_version = 37');
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
  }

  if (current < 38) {
    // v38 (Slice 4 Task 6) extends the `approach_node_overrides` placeholder
    // with the category-specific override surface: `kind` (one of the closed
    // `NodeOverrideKind` set), the `value` JSON, and `created_at`, plus the
    // `(revision_id, node_id, kind)` uniqueness that scopes an override to ONE
    // node in ONE revision. A fresh DB already carries all of it (schema.sql),
    // so the guards skip; a legacy v35–v37 DB gains the columns through the
    // same ALTER the placeholder's empty shape needs. The claim CAS is the
    // NODE RUN status (ready/blocked/failed-to-launch editable), never the
    // override row; `row_version` stays for concurrent-write optimism.
    //
    // NOTHING IS BACKFILLED. No prior karst wrote a `kind`/`value`; legacy
    // placeholder rows (if any) default to the inert `provider`/'' pair.
    const overrideCols = tableColumns(db, 'approach_node_overrides');
    if (overrideCols.size > 0 && !overrideCols.has('kind')) {
      db.exec(
        "ALTER TABLE approach_node_overrides ADD COLUMN kind TEXT NOT NULL DEFAULT 'provider' " +
          "CHECK (kind IN ('profile','provider','model','effort','prompt'))",
      );
      db.exec("ALTER TABLE approach_node_overrides ADD COLUMN value TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE approach_node_overrides ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_node_overrides_rev_node_kind
         ON approach_node_overrides(revision_id, node_id, kind)`,
    );
  }

  if (current < 39) {
    // v39 (Slice 5 Task 1) adds the node execution workspace shape: the
    // claim-time base heads on each node run, the graph run's aggregate
    // workspace byte total, and the per-workspace ledger table. A fresh DB
    // already carries all of it (schema.sql — including inside
    // GRAPH_MIGRATION_DDL, so the guards skip); a legacy DB gains the columns
    // through the same guarded ALTERs and the ledger through IF NOT EXISTS.
    //
    // NOTHING IS BACKFILLED. No prior karst captured base heads or counted
    // workspace bytes; NULL/0 name the unknown, never an invented value.
    const nodeCols39 = tableColumns(db, 'approach_node_runs');
    if (nodeCols39.size > 0 && !nodeCols39.has('base_heads')) {
      db.exec('ALTER TABLE approach_node_runs ADD COLUMN base_heads TEXT');
    }
    const runCols39 = tableColumns(db, 'approach_graph_runs');
    if (runCols39.size > 0 && !runCols39.has('workspace_bytes')) {
      db.exec('ALTER TABLE approach_graph_runs ADD COLUMN workspace_bytes INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(GRAPH_WORKSPACE_MIGRATION_DDL);
  }

  if (current < 40) {
    // v40 (Slice 5 Task 3) adds the scheduler shape: the graph run's
    // `active_processes` counter (the coordinator's own accounting of the
    // external-process ceiling `graph.limits.maxParallel`) and the
    // `approach_node_deferrals` ledger — one row per ready-but-blocked node
    // carrying the refusal reason and `wait_since` for bounded aging. A fresh
    // DB already carries both (schema.sql — including inside
    // GRAPH_MIGRATION_DDL, so the guards skip); a legacy DB gains the column
    // through the guarded ALTER and the ledger through IF NOT EXISTS.
    //
    // NOTHING IS BACKFILLED. No prior karst counted active processes or
    // recorded a deferral; 0/absent name the unknown, never an invented value.
    const runCols40 = tableColumns(db, 'approach_graph_runs');
    if (runCols40.size > 0 && !runCols40.has('active_processes')) {
      db.exec('ALTER TABLE approach_graph_runs ADD COLUMN active_processes INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(GRAPH_DEFERRAL_MIGRATION_DDL);
  }

  if (current < 41) {
    // v41 (Slice 5 Task 4) adds the fork-execution identity
    // `fork_instance_id` (host-minted UUIDv7) to each activation token. A
    // fresh DB already carries it (schema.sql — including inside
    // GRAPH_MIGRATION_DDL, so the guard skips); a legacy DB gains the column
    // through the guarded ALTER. The join-correlation UNIQUE index stays on
    // the INTEGER `fork_instance` pair, which is unchanged.
    //
    // NOTHING IS BACKFILLED. No prior karst minted a fork instance id; NULL
    // is the legacy answer, and correlation never depends on the id.
    const tokenCols41 = tableColumns(db, 'approach_graph_tokens');
    if (tokenCols41.size > 0 && !tokenCols41.has('fork_instance_id')) {
      db.exec('ALTER TABLE approach_graph_tokens ADD COLUMN fork_instance_id TEXT');
    }
  }

  if (current < 42) {
    // v42 adds the AGENT TEST DRIVER's two evidence tables (Phase 1 of the
    // agent-test-driver ticket): `test_logs` (structured log rows) and
    // `test_hooks` (hook events the `karst test simulate-hook` subcommand
    // dispatched). The tables landed at v35 on develop — the graph tables this
    // branch added at v35-v41 were developed in parallel — so this merge step
    // renumbers them to v42, after every graph step. A whole new table set, so
    // the step is the same DDL as schema.sql rather than ALTERs, and every
    // statement is IF NOT EXISTS — a fresh DB (already carrying it) and a
    // re-open are both no-ops.
    //
    // NOTHING IS BACKFILLED. No prior karst recorded structured test logs or
    // dispatched-hook events — the driver did not exist — and synthesizing
    // rows would assert exactly the facts these tables exist to record.
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_logs (
        id            INTEGER PRIMARY KEY,
        ticket_id     INTEGER,
        level         TEXT NOT NULL,
        module        TEXT NOT NULL,
        message       TEXT NOT NULL,
        meta          TEXT,
        recorded_at   TEXT NOT NULL
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_test_logs_ticket ON test_logs(ticket_id, id)',
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_hooks (
        id                INTEGER PRIMARY KEY,
        ticket_id         INTEGER,
        event             TEXT NOT NULL,
        session_id        TEXT,
        payload           TEXT,
        agent_state_after TEXT,
        recorded_at       TEXT NOT NULL
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_test_hooks_ticket ON test_hooks(ticket_id, id)',
    );
  }

  if (current < 43) {
    // v43 normalizes legacy follow-up titles (869ehqx68). Creation used to
    // store `Follow-up: <parent title>` as the title; that prefix is
    // relationship identity, not part of the task title, so it is stripped.
    // Stripped REPEATEDLY so a nested `Follow-up: Follow-up: X` (a follow-up of
    // a follow-up re-prefixing an already-prefixed title) converges to the
    // plain task title. Guarded to actual follow-ups (`parent_ticket_id IS NOT
    // NULL`) matching the literal creation-time prefix, and to titles longer
    // than the prefix (a bare `Follow-up: ` must not become empty), so a
    // hand-written title is never touched. A fresh DB has no such rows — no-op.
    // The step also only runs when the tickets table exists with the v14+
    // parent column, so a partial-schema DB (e.g. a lone attachments table in
    // a repair test) skips instead of failing to prepare the statement.
    const cols = ticketColumns(db);
    if (cols.has('title') && cols.has('parent_ticket_id')) {
      const strip = db.prepare(
        `UPDATE tickets SET title = substr(title, 12)
          WHERE parent_ticket_id IS NOT NULL
            AND title LIKE 'Follow-up: %'
            AND length(title) > 11`,
      );
      db.transaction(() => {
        while (strip.run().changes > 0) {
          // keep stripping leading prefixes until none remain
        }
      })();
    }
  }

  if (current < 44) {
    // v44, added independently on two branches and merged into one step:
    // 1. the per-ticket effort/variant override, the launch-path sibling of
    //    `model`/`agent_provider` (§ Execution policy resolution).
    // A fresh DB already carries it (schema.sql); the guard only runs the
    // ALTER for a legacy DB being upgraded. NOTHING IS BACKFILLED: a pre-v44
    // ticket has no effort to synthesize — NULL is the honest "inherit the
    // default" reading. The `ticketColumns` guard is checked for a NON-empty
    // set first, so a partial-schema DB (e.g. a lone attachments table in a
    // repair test) skips instead of failing to prepare the ALTER.
    // (The provider-native `priority` label also shipped in v44 — see the
    // ungated repair below, which is what actually lands it on an upgraded DB.)
    const cols = ticketColumns(db);
    if (cols.has('model') && !cols.has('effort')) {
      db.exec('ALTER TABLE tickets ADD COLUMN effort TEXT');
    }
  }

  if (current < 45) {
    // v45: reasoning ("thinking") tokens as their own counter on both usage
    // tables. opencode reports `tokens.reasoning` beside `output` — a live
    // session carrying 8_220 output carried 40_485 reasoning — and karst read
    // neither the interactive sample nor the headless envelope for it, so
    // output-billed spend was missing from every total. The guards read the
    // CURRENT columns, so a fresh DB (already carrying them via schema.sql) is
    // a no-op and a re-open is idempotent. NOTHING IS BACKFILLED: a pre-v45 row
    // was measured without the counter and its reasoning spend is unknowable —
    // the ledger's DEFAULT 0 is the honest "this row never reported one", and
    // an invented number would read as measured.
    // (The `recovery_rounds.interrupt_count` counter also shipped in v45 — see
    // the ungated repair below, which is what actually lands it on an upgraded DB.)
    const usageCols = tableColumns(db, 'token_usage');
    if (usageCols.size > 0 && !usageCols.has('reasoning_tokens')) {
      db.exec(
        'ALTER TABLE token_usage ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0',
      );
    }
    const sampleCols = tableColumns(db, 'interactive_usage_samples');
    if (sampleCols.size > 0 && !sampleCols.has('reasoning_tokens')) {
      db.exec('ALTER TABLE interactive_usage_samples ADD COLUMN reasoning_tokens INTEGER');
    }
  }

  if (current < 46) {
    // v46: `servers.kind` distinguishes a real service from a graph agent
    // session. Graph sessions register in `servers` so the reapers kill them
    // (869ed2n50), but the services DISPLAY must not read them as services.
    // The guard reads the CURRENT columns, so a fresh DB (already carrying it
    // via schema.sql) is a no-op and a re-open is idempotent. NOTHING IS
    // BACKFILLED: a pre-v46 row predates the distinction and is a service (the
    // DEFAULT), which is the honest answer — every pre-v46 row was one.
    const serverCols = tableColumns(db, 'servers');
    if (serverCols.size > 0 && !serverCols.has('kind')) {
      db.exec("ALTER TABLE servers ADD COLUMN kind TEXT NOT NULL DEFAULT 'service'");
    }
  }

  if (current < 47) {
    // v47: collapse duplicate `prs` rows for the same (ticket_id, repo, url)
    // and add a UNIQUE index so it cannot regress. The idempotency guard ship
    // used to re-adopt a repo's PR (`existingOpen`) matched only
    // `status = 'open'`, but `updatePrDetail` overwrites that status with the
    // PR's real upstream state right after the row is created — 'draft' for a
    // draft PR — so the very next retry missed the guard, re-adopted the same
    // GitHub PR via `findOpenPr`, and the plain INSERT it used back then added
    // a second row for the same PR (a real report showed two rows both #3461,
    // both 'draft'). `recordShippedPr` (store/prs.ts) is the idempotent
    // replacement; this step cleans up what the old INSERT already wrote.
    //
    // For each duplicate group, keep the row with the most non-null v16
    // metadata columns (head_ref/base_ref/created_at/merged_at/comments) —
    // the "richest" answer gh has given so far — breaking ties by the lowest
    // rowid (the original row). Every other row in the group is deleted.
    // Idempotent: a DB with no duplicates (fresh or already-migrated) touches
    // nothing here, and re-running finds no groups left to collapse.
    const prsCols = tableColumns(db, 'prs');
    const dupGroups =
      prsCols.size > 0
        ? (db
            .prepare(
              `SELECT ticket_id, repo, url, COUNT(*) AS n
                 FROM prs
                WHERE url IS NOT NULL
                GROUP BY ticket_id, repo, url
               HAVING COUNT(*) > 1`,
            )
            .all() as Array<{ ticket_id: number; repo: string; url: string; n: number }>)
        : [];
    if (dupGroups.length > 0) {
      const rowsForGroup = db.prepare(
        `SELECT rowid, head_ref, base_ref, created_at, merged_at, comments
           FROM prs WHERE ticket_id = ? AND repo = ? AND url = ?
          ORDER BY rowid ASC`,
      );
      const deleteRow = db.prepare('DELETE FROM prs WHERE rowid = ?');
      for (const group of dupGroups) {
        const rows = rowsForGroup.all(group.ticket_id, group.repo, group.url) as Array<{
          rowid: number;
          head_ref: string | null;
          base_ref: string | null;
          created_at: string | null;
          merged_at: string | null;
          comments: string | null;
        }>;
        const richness = (r: (typeof rows)[number]): number =>
          [r.head_ref, r.base_ref, r.created_at, r.merged_at, r.comments].filter(
            (v) => v !== null,
          ).length;
        let keep = rows[0]!;
        for (const r of rows.slice(1)) {
          if (richness(r) > richness(keep)) keep = r;
        }
        for (const r of rows) {
          if (r.rowid !== keep.rowid) deleteRow.run(r.rowid);
        }
      }
    }
    if (prsCols.size > 0) {
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_prs_ticket_repo_url ON prs(ticket_id, repo, url)',
      );
    }
  }

  // The tickets.priority step cannot be version-gated, and repairing the
  // CURRENT shape outside the gate is deliberate — the same reason the
  // servers.cwd repair above runs ungated. v44 was bumped INDEPENDENTLY on two
  // branches: the per-ticket `effort` override (#215) and the provider-native
  // `priority` label (#216), merged into one step. A registry migrated by the
  // earlier build reports user_version = 44 while `tickets` still lacks
  // `priority` — not < 44 — so the version-gated ALTER would be skipped
  // forever and the ticket form's fetch would die with "no such column:
  // priority" (869ej2cfz). The guard reads the CURRENT columns, never the
  // version, so a fresh DB (already carrying it via schema.sql) is a no-op and
  // a legacy DB missing it is repaired however it got here. NOTHING IS
  // BACKFILLED: a ticket that predates the column has no provider priority to
  // derive, so it stays NULL and the next fetch populates it.
  const priorityCols = ticketColumns(db);
  if (priorityCols.size > 0 && !priorityCols.has('priority')) {
    db.exec('ALTER TABLE tickets ADD COLUMN priority TEXT');
  }

  // The recovery_rounds.interrupt_count step cannot be version-gated, and
  // repairing the CURRENT shape outside the gate is deliberate — the same
  // reason the servers.cwd and tickets.priority repairs above run ungated.
  // v45 was bumped INDEPENDENTLY on two branches: the usage reasoning-token
  // counters (#247) and the recovery-round interrupt counter (this ticket),
  // merged into one step. A registry migrated by the earlier build reports
  // user_version = 45 while `recovery_rounds` still lacks `interrupt_count` —
  // not < 45 — so the version-gated ALTER would be skipped forever and the
  // driver's recovery loop would read a schema it never extended. The guard
  // reads the CURRENT columns, never the version, so a fresh DB (already
  // carrying it via schema.sql) is a no-op and a legacy DB missing it is
  // repaired however it got here. NOTHING IS BACKFILLED: a round interrupted by
  // a pre-v45 build has no count to synthesize — its first post-upgrade
  // interrupt sets the count that bounds it.
  const roundCols = tableColumns(db, 'recovery_rounds');
  if (roundCols.size > 0 && !roundCols.has('interrupt_count')) {
    db.exec('ALTER TABLE recovery_rounds ADD COLUMN interrupt_count INTEGER NOT NULL DEFAULT 0');
  }

  // The gate_runs.summary step cannot be version-gated, and repairing the
  // CURRENT shape outside the gate is deliberate — the same reason the
  // servers.cwd, tickets.priority and recovery_rounds.interrupt_count repairs
  // above run ungated. v46 was bumped INDEPENDENTLY on two branches: graph
  // sessions' `servers.kind` (#257) and this failure summary (#259), merged
  // into two separate steps sharing one version number. A registry migrated
  // by the earlier build (servers.kind only) reports user_version = 46 while
  // `gate_runs` still lacks `summary` — not < 46 — so the version-gated ALTER
  // was skipped forever and every dashboard/ticket-list fetch that reads
  // gate_runs died with "no such column: summary". The guard reads the
  // CURRENT columns, never the version, so a fresh DB (already carrying it via
  // schema.sql) is a no-op and a legacy DB missing it is repaired however it
  // got here. NOTHING IS BACKFILLED: a pre-v46 failing gate's output is in its
  // artifact log, not derivable from the stored row.
  const gateCols = tableColumns(db, 'gate_runs');
  if (gateCols.size > 0 && !gateCols.has('summary')) {
    db.exec('ALTER TABLE gate_runs ADD COLUMN summary TEXT');
  }

  // v48 — per-repo base branch chosen before the ticket is spun. Nothing to
  // backfill: an absent value means "use the manifest default", which is
  // exactly what every pre-v48 ticket did.
  const baseRefCols = tableColumns(db, 'tickets');
  if (baseRefCols.size > 0 && !baseRefCols.has('base_refs')) {
    db.exec('ALTER TABLE tickets ADD COLUMN base_refs TEXT');
  }

  // v49 — a base change rebases the ticket branch, which rewrites its commits;
  // the next push must carry a lease or the remote rejects it. Nothing to
  // backfill: no pre-v49 branch was rewritten by karst.
  const worktreeCols = tableColumns(db, 'worktrees');
  if (worktreeCols.has('base_ref') && !worktreeCols.has('needs_force_push')) {
    db.exec('ALTER TABLE worktrees ADD COLUMN needs_force_push INTEGER');
  }

  // v50 — the runtime per-ticket debug trail (`ticket_logs`), read back by the
  // dashboard's Inside component. CREATE TABLE IF NOT EXISTS so a fresh DB
  // (schema.sql already carries it) is a no-op; nothing to backfill — pre-v50
  // tickets have no captured debug trail, which is the truthful answer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_logs (
      id            INTEGER PRIMARY KEY,
      ticket_id     INTEGER NOT NULL,
      level         TEXT NOT NULL,
      module        TEXT NOT NULL,
      message       TEXT NOT NULL,
      recorded_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_logs_ticket ON ticket_logs(ticket_id, id);
  `);

  // v51 — debug lines belong solely in the extension's Output channel
  // (`logger.debug`, already gated on the manifest's `debug` flag). The v50
  // `ticket_logs` duplicate — a DB-backed trail surfaced in the dashboard's
  // Inside component — is dropped; nothing to preserve, it was a rendering
  // surface, not a record of user data.
  db.exec('DROP TABLE IF EXISTS ticket_logs;');

  // v52 — task pause timestamp column (`tickets.paused_at`).
  const ticketColsV52 = tableColumns(db, 'tickets');
  if (ticketColsV52.size > 0 && !ticketColsV52.has('paused_at')) {
    db.exec('ALTER TABLE tickets ADD COLUMN paused_at TEXT');
  }

  if (current < 53) {
    // v53 (Task 1A, recovery-round-exhaustion): six schema changes land as
    // ONE version bump — see RECOVERY_ROUNDS_V53_DDL / STAGES_V53_DDL above
    // for the two non-additive rebuilds (SQLite cannot ALTER a CHECK
    // constraint) and their row repairs. `review_findings.identity` is
    // additive (no CHECK to widen), so it takes a plain guarded ALTER.
    //
    // Both rebuild guards read the CURRENT table SQL — a fresh DB
    // (schema.sql already carries the widened shape) skips the rebuild
    // entirely, and a re-open on an already-migrated DB is a no-op. The whole
    // rebuild (both tables' DDL + the version bump) runs inside ONE
    // transaction, mirroring v35/v37's interruption-atomicity pattern: a
    // poisoned step rolls back the lot and user_version stays below 53, so
    // the next open re-runs the same guarded steps. Foreign-key enforcement
    // is suspended for the swap (it cannot change inside a transaction); the
    // renames restore the names every FK clause references.
    const roundsSql53 = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recovery_rounds'",
        )
        .get() as { sql: string } | undefined
    )?.sql;
    const stagesSql53 = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stages'")
        .get() as { sql: string } | undefined
    )?.sql;
    const needsRoundsRebuild = !!roundsSql53 && !roundsSql53.includes("'refused'");
    const needsStagesRebuild = !!stagesSql53 && !stagesSql53.includes('ended_at >= started_at');

    if (needsRoundsRebuild || needsStagesRebuild) {
      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (needsRoundsRebuild) db.exec(RECOVERY_ROUNDS_V53_DDL);
          if (needsStagesRebuild) db.exec(STAGES_V53_DDL);
          db.pragma('user_version = 53');
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }

    // review_findings.identity: NULL for every pre-v53 row and any writer
    // that predates the hash — not derivable after the fact, every reader
    // must degrade.
    const findingsCols53 = tableColumns(db, 'review_findings');
    if (findingsCols53.size > 0 && !findingsCols53.has('identity')) {
      db.exec('ALTER TABLE review_findings ADD COLUMN identity TEXT');
    }
  }

  if (current < 54) {
    // v54: `servers.container` records the docker container a service runs in.
    // A pid is a recollection the OS may have reissued (which is why
    // `serverIdentity.ts` refuses to signal an unattributable one); a container
    // NAME is not reissued, so it is the handle every stop and reap path uses to
    // make sure the container itself is gone — killing the attached client alone
    // would leave it running with its port bound. NULL means "not a container",
    // which is the honest answer for every pre-v54 row: none of them were.
    //
    // The guard reads the CURRENT columns, never the version, so a fresh DB
    // (already carrying it via schema.sql) is a no-op and a re-open is
    // idempotent.
    const serverCols54 = tableColumns(db, 'servers');
    if (serverCols54.size > 0 && !serverCols54.has('container')) {
      db.exec('ALTER TABLE servers ADD COLUMN container TEXT');
    }
  }

  if (current < 55) {
    // v55: `tickets.env_overrides` holds the per-ticket env the spin merges into
    // its hot services' spawn env — JSON scope → {KEY: value}, where the scope
    // is a manifest repository name or `*` for every service. NULL means
    // "nothing overridden", the honest answer for every pre-v55 row, and the
    // one nothing needs backfilling to reach.
    //
    // The guard reads the CURRENT columns, never the version, so a fresh DB
    // (already carrying it via schema.sql) is a no-op and a re-open is
    // idempotent.
    const ticketCols55 = tableColumns(db, 'tickets');
    if (ticketCols55.size > 0 && !ticketCols55.has('env_overrides')) {
      db.exec('ALTER TABLE tickets ADD COLUMN env_overrides TEXT');
    }
  }


  if (current < 56) {
    // v56: `prs.dismissed_at` records that a human declared this PR will never
    // land — the PR closed because the changes turned out to be unneeded. The
    // merge gate stops waiting on a dismissed PR, which is what unsticks a
    // multi-repo ticket parked at `ship` behind a closed PR that can never
    // become 'merged'. It is deliberately NOT a status value: gh owns `status`
    // and re-probes it, and an acknowledgement of ours must survive that.
    // NULL means "still expected to land" — true of every pre-v56 row.
    //
    // The guard reads the CURRENT columns, never the version, so a fresh DB
    // (already carrying it via schema.sql) is a no-op and a re-open is
    // idempotent.
    const prCols56 = tableColumns(db, 'prs');
    if (prCols56.size > 0 && !prCols56.has('dismissed_at')) {
      db.exec('ALTER TABLE prs ADD COLUMN dismissed_at TEXT');
    }
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
