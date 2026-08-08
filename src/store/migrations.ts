import type { Database } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** Bump when the schema changes; drives forward migrations. */
export const SCHEMA_VERSION = 31;

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

  if (current < 21) {
    // v21 records a server's working directory, so a live pid can be tied back
    // to the tree it serves. Without it, removing a worktree left its dev server
    // running forever: reparented to init, holding ~1 GB and its port, serving a
    // directory that no longer exists (869ed2n50).
    //
    // Not backfilled, and deliberately not guessed: `repo` is a repository NAME
    // while worktrees are keyed by PATH, and several repository entries may
    // share one worktree — the mapping is not derivable from the registry. A
    // NULL cwd reads as "unknown" everywhere it is consumed, so a legacy row is
    // never reaped on a guess.
    const serverCols = tableColumns(db, 'servers');
    if (serverCols.size > 0 && !serverCols.has('cwd')) {
      db.exec('ALTER TABLE servers ADD COLUMN cwd TEXT');
    }
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

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
