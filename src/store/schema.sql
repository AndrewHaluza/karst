-- Karst reference registry (§6) — the keystone.
-- The daemon is the sole writer; the board queries this constantly.
-- MVP drops the deferred `events` feed (T1.1 decision); it re-adds additively.

-- One row per workspace Karst is driving. The slug (manifest `id:`, else a
-- path-derived fallback) is the identity; root_path is advisory display only,
-- because a project keeps its identity across a move.
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT,
  root_path     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id                INTEGER PRIMARY KEY,
  key               TEXT,                 -- "PROJ-142"
  title             TEXT,
  source            TEXT,                 -- jira | clickup | trello | manual
  stage_current     TEXT,                 -- StageKey
  agent_state       TEXT,                 -- running | waiting | idle | none
  session_id        TEXT,                 -- for --resume
  -- v2 ticket-field columns (kept in sync with migrations.ts v2 ALTERs):
  description       TEXT,                 -- ticket requirements / acceptance criteria
  brief             TEXT,                 -- synthesized context brief (from fetch)
  source_ref        TEXT,                 -- board task id/url the ticket was fetched from
  source_fetched_at TEXT,                 -- when the source was last fetched
  approach          TEXT,                 -- chosen development approach id
  agent             TEXT,                 -- chosen single-subagent id (nullable)
  selected_repos    TEXT,                 -- JSON array of confirmed repository names
  -- v3 lifecycle column (kept in sync with migrations.ts v3 ALTER):
  archived_at       TEXT,                 -- soft-delete timestamp; NULL = active
  -- v5 model column (kept in sync with migrations.ts v5 ALTER):
  model             TEXT,                 -- per-ticket launch model id; NULL = inherit default
  -- v6 project column (kept in sync with migrations.ts v6 ALTER):
  project_id        INTEGER,              -- -> projects.id; NULL = unassigned (pre-v6 ticket)
  -- v12 agent_provider column (kept in sync with migrations.ts v12 ALTER):
  agent_provider    TEXT,                 -- per-ticket agent core override; NULL = inherit manifest default
  -- v13 session_provider column (kept in sync with migrations.ts v13 ALTER):
  session_provider  TEXT,                 -- agent core that minted session_id; NULL = unknown, never resume
  -- v14 parent_ticket_id column (kept in sync with migrations.ts v14 ALTER):
  parent_ticket_id  INTEGER,              -- -> tickets.id; links a follow-up ticket to the parent it continues
  -- v15 conventional-commit type (kept in sync with migrations.ts v15 ALTER):
  type              TEXT,                 -- feat | fix | … ; NULL = inherit conventions.defaultType
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_ticket_id);

CREATE TABLE IF NOT EXISTS stages (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  stage_key     TEXT NOT NULL,        -- StageKey (no `fetch` in MVP, C1)
  status        TEXT NOT NULL,        -- pending | running | passed | failed | skipped
  attempt       INTEGER NOT NULL DEFAULT 0,  -- review/fix loop iteration
  verdict       TEXT,
  artifact_path TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  -- v17 blocked columns (kept in sync with migrations.ts v17 ALTERs).
  -- A block is karst saying it could not ASK the question — distinct from a
  -- `failed` verdict, which says the code is wrong. NULL kind = not blocked, so
  -- there is nothing to backfill and no status value had to change.
  blocked_kind   TEXT,                -- BlockerKind; NULL = not blocked
  blocked_reason TEXT,                -- the specific text a human needs
  blocked_at     TEXT,
  PRIMARY KEY (ticket_id, stage_key)
);

-- One row per gate, per gate-runner invocation (uat/review evidence). APPEND-ONLY:
-- `stages` above is keyed (ticket_id, stage_key) and a retry overwrites it in
-- place, so this is the only place a prior attempt's evidence survives. Never
-- UPDATEd.
--
-- The identity is the surrogate `id`, not the natural (ticket, stage, attempt,
-- gate) — that is NOT unique. `transition` bumps `attempt` only on the failed
-- branch, so review-fail (attempt->1) -> fix -> review-pass files two distinct
-- invocations under attempt 1. `run_at` is what groups one invocation's rows.
CREATE TABLE IF NOT EXISTS gate_runs (
  id            INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS run order
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  stage_key     TEXT NOT NULL,        -- 'uat' | 'review' (GATE_STAGES)
  attempt       INTEGER NOT NULL,     -- the stage's attempt when this batch ran
  run_at        TEXT NOT NULL,        -- batch stamp: one runner invocation
  gate_name     TEXT NOT NULL,        -- lint | typecheck | test
  exit_code     INTEGER,              -- NULL = repo defines no such script (NOT a pass)
  started_at    TEXT,
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_gate_runs_ticket ON gate_runs(ticket_id, stage_key, id);

-- Phases an agent REPORTED entering during a marker stage. Append-only, like
-- gate_runs and for the same reason: a phase is an event, many per stage, so it
-- cannot live on `stages` (one row per StageKey, single-writer via setStage).
-- Each row is a point-in-time mark, never a span: a started/ended pair would pin
-- a phase "running" forever whenever a closing marker is missed. A phase's
-- duration is derivable from the next mark; the last one's is genuinely unknown.
-- A mark is deterministic evidence that the marker command ran. The ABSENCE of a
-- mark is evidence of nothing — never "skipped", never "pending".
CREATE TABLE IF NOT EXISTS phase_marks (
  id            INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS report order
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  stage_key     TEXT NOT NULL,        -- always 'impl' today (PHASE_MARK_STAGE); the
                                      -- column is here so a `fix` marker needs no
                                      -- migration, but nothing writes one yet — that
                                      -- needs a stage token on the CLI wire format.
  attempt       INTEGER NOT NULL,     -- the stage's attempt when this mark landed
  phase_name    TEXT NOT NULL,        -- as reported; NOT constrained to the declared list
  marked_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phase_marks_ticket ON phase_marks(ticket_id, stage_key, id);

CREATE TABLE IF NOT EXISTS worktrees (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  repo          TEXT NOT NULL,
  path          TEXT NOT NULL,
  branch        TEXT,
  base_ref      TEXT,                 -- branch point, for staleness (§9)
  deps_mode     TEXT NOT NULL DEFAULT 'inherited',  -- inherited | local (§8.2)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worktree_archives (
  id              INTEGER PRIMARY KEY,
  ticket_id       INTEGER NOT NULL,     -- -> tickets.id
  repo            TEXT NOT NULL,        -- worktrees.repo (the repoPath)
  path            TEXT NOT NULL,        -- original worktree folder (restore target)
  branch          TEXT NOT NULL,        -- karst/<slug>, survives archive
  base_ref        TEXT,                 -- branch point, carried from the worktrees row
  archive_ref     TEXT NOT NULL,        -- refs/karst/archive/<slug>; '' = no uncommitted delta
  method          TEXT NOT NULL,        -- 'git-ref' (only value in v1)
  reclaimed_bytes INTEGER,              -- reserved/nullable; not populated in v1
  archived_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_worktree_archives_ticket ON worktree_archives(ticket_id, path);

CREATE TABLE IF NOT EXISTS port_allocations (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  repo          TEXT NOT NULL,        -- repository name (renamed from `service` in v10)
  port_name     TEXT NOT NULL,
  port          INTEGER NOT NULL,
  UNIQUE (port)                       -- the correctness guard under concurrency
);

CREATE TABLE IF NOT EXISTS baseline_refs (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  repo          TEXT NOT NULL,        -- repository name (renamed from `service` in v10)
  PRIMARY KEY (ticket_id, repo)
);

CREATE TABLE IF NOT EXISTS servers (
  id            INTEGER PRIMARY KEY,
  ticket_id     INTEGER,              -- NULL => baseline singleton
  repo          TEXT NOT NULL,        -- repository name (renamed from `service` in v10)
  host          TEXT,
  port          INTEGER,
  pid           INTEGER,
  status        TEXT NOT NULL,        -- running | stopped
  log_path      TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- The directory the process was spawned in (v21) — normally a ticket's
  -- worktree. It is what ties a live pid to the tree it serves, so removing that
  -- tree can reap the servers it leaves behind and a boot sweep can spot a
  -- server whose directory is gone. NULL for rows written before v21: unknown,
  -- never assumed.
  --
  -- Placed LAST, matching where the v21 migration's `ALTER TABLE ADD COLUMN`
  -- necessarily puts it on an upgraded DB (SQLite always appends) — a fresh DB
  -- and a migrated one would otherwise disagree on column order. Nothing reads
  -- `servers` by position (every query here names its columns), so the order
  -- has no behavioral effect either way; this just keeps the two schemas
  -- byte-for-byte comparable.
  cwd           TEXT
);

-- One PR per (ticket, repo). `status` and every v16 metadata column below are
-- CURRENT STATE, not evidence: they are re-probed from gh and overwritten, for
-- the same reason merge_checks is not append-only — a stale "open" for a merged
-- PR is a wrong answer stated confidently. Every metadata column is nullable
-- because it is gh's answer, not ours: a probe that could not see the PR leaves
-- NULL, and NULL renders as "not stated" rather than as a blank or a guess.
CREATE TABLE IF NOT EXISTS prs (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  repo          TEXT NOT NULL,
  number        INTEGER,
  url           TEXT,
  status        TEXT,
  head_ref      TEXT,                 -- v16: source branch (gh headRefName)
  base_ref      TEXT,                 -- v16: target branch (gh baseRefName)
  created_at    TEXT,                 -- v16: PR creation stamp, ISO-8601 from gh
  merged_at     TEXT,                 -- v16: merge stamp; NULL until actually merged
  comments      TEXT                  -- v16: JSON array of {author,at,body}; see store/prComments.ts
);

-- Whether a ticket's branch still merges into its base, per repo, as of the last
-- ship. NOT append-only, unlike gate_runs and phase_marks, and the difference is
-- the point: those record that an event happened, this records what is true NOW.
-- Mergeability is a property of two moving refs, so yesterday's `clean` is not
-- weaker evidence — it is a lie, and the one presented most confidently. A
-- re-check therefore OVERWRITES (upsert on the natural key) rather than appending.
--
-- Keyed (ticket_id, repo): each worktree targets its own base_ref, so conflict is
-- per-repo, and one current answer per repo is exactly the question consumers ask.
--
-- `state` is three-valued on purpose. 'unknown' is not a degraded 'clean': it is
-- the absence of an answer, and `reason` carries git's own words for why.
CREATE TABLE IF NOT EXISTS merge_checks (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  repo          TEXT NOT NULL,        -- matches worktrees.repo
  state         TEXT NOT NULL,        -- clean | conflicted | unknown
  files         TEXT NOT NULL,        -- JSON array of conflicting paths; '[]' when none
  reason        TEXT,                 -- git's own message; NULL unless state='unknown'
  head_sha      TEXT,                 -- the SHAs the verdict was computed from, so a
  base_sha      TEXT,                 -- reader can tell a current answer from a stale one
  base_ref      TEXT,
  checked_at    TEXT NOT NULL,
  PRIMARY KEY (ticket_id, repo)
);

-- One row per instrumented AI/LLM invocation (§ token consumption stats).
-- APPEND-ONLY evidence, like gate_runs and phase_marks and for the same reason:
-- a call is an EVENT. It cannot live on `tickets` (one row per ticket) or on
-- `stages` (one row per stage_key, overwritten by a retry), and the whole value
-- of the table is that a prior expensive attempt still shows up in the totals.
-- Nothing UPDATEs it.
--
-- No prompt or completion TEXT is ever stored here — only counts and metadata.
-- That is a hard rule, not an omission: this table is queried by an aggregate
-- view, ticket content is confidential, and a column that could hold it would
-- eventually hold it.
--
-- `ticket_id` is nullable because the first AI call of a ticket's life (the
-- ticket-form analyzer) runs while the ticket is still an unsaved draft. Such a
-- call is real spend and is recorded unattributed rather than dropped.
-- `project_id` scopes the table for the same reason every ticket query is
-- scoped: the DB lives in global storage and is shared by every IDE window.
--
-- `estimated` marks a row whose counts came from `estimateTokenUsage` because
-- the core reported none. It is carried to the view so an approximation is
-- never presented as measured.
CREATE TABLE IF NOT EXISTS token_usage (
  id                 INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS call order
  project_id         INTEGER,              -- -> projects.id; NULL = unscoped (recovery only)
  ticket_id          INTEGER,              -- -> tickets.id; NULL = not yet a ticket (draft)
  call_site          TEXT NOT NULL,        -- AiCallSite (agent/aiCallSites.ts) — a closed set
  provider           TEXT,                 -- claude | codex | antigravity
  model              TEXT,                 -- model id the core reported; NULL = it did not say
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  estimated          INTEGER NOT NULL DEFAULT 0,  -- 1 = counts are an estimate, not a report
  outcome            TEXT NOT NULL,        -- ok | error (a failed call still burned tokens)
  recorded_at        TEXT NOT NULL         -- ISO-8601; what every time-range filter cuts on
);
-- The aggregation index set. Every stats query filters on (project_id,
-- recorded_at) and then groups by one of ticket / call_site / model, so each
-- grouping gets a covering leading edge — the rollups stay in SQLite as the row
-- count grows instead of becoming an in-memory scan.
CREATE INDEX IF NOT EXISTS idx_token_usage_project_time ON token_usage(project_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_ticket ON token_usage(ticket_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_site ON token_usage(project_id, call_site, recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(project_id, model, recorded_at);

-- Images and video attached to a ticket's prompt. An INDEX of bytes that live on
-- disk under <globalStorage>/attachments/<ticket_id>/<stored_name>, never the
-- bytes themselves: a 200 MB mp4 in a row would be read by every query that
-- selects *, and the agent needs a real file path regardless.
--
-- `kind` is resolved ONCE at ingest, against the whitelist in
-- attachments/kinds.ts, and stored. Nothing re-derives it from a filename later,
-- so a row's kind cannot drift from the value that was actually validated.
--
-- `stored_name` is content-addressed (<sha256[0..16]>.<ext>) and is the ONLY
-- name that touches the filesystem. `original_name` is what the user called the
-- file; it is display-only and is never joined into a path, which is what makes
-- a crafted name like '../../../.ssh/id_rsa' inert rather than dangerous.
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  kind          TEXT NOT NULL,        -- image | video
  stored_name   TEXT NOT NULL,        -- <sha256[0..16]>.<ext>; the on-disk name
  original_name TEXT NOT NULL,        -- display only; never a path component
  byte_size     INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  operation_token TEXT,               -- transient attach cross-window claim
  detach_token    TEXT                -- detach handshake; attach waits for its release
);

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket
  ON ticket_attachments(ticket_id, id);

-- Global storage is shared across IDE windows. Let SQLite, rather than a
-- process-local find-then-insert check, arbitrate two windows attaching the
-- same content-addressed file at once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_attachments_ticket_stored_name
  ON ticket_attachments(ticket_id, stored_name);
