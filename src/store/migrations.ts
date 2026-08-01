import type { Database } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** Bump when the schema changes; drives forward migrations. */
export const SCHEMA_VERSION = 18;

/** v2 onboarding columns added to `tickets`; mirror schema.sql for fresh DBs. */
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
 * v2 adds onboarding columns to `tickets`. A fresh DB already has them (schema.sql
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

/** Tables whose `service` column became `repo` in v10. */
const V10_RENAMED_TABLES = ['servers', 'port_allocations', 'baseline_refs'] as const;

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  if (current < 1) {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);
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
    // and the artifact filenames are fixed (`review-ticket-<id>.log`), so every
    // retry overwrote its predecessor's log. There is no source from which past
    // gate results could be derived — inventing rows here would be exactly the
    // inference the no-inference guarantee forbids. In-flight tickets show no
    // recorded gates until their next gate run.
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

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
