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
  -- v24 per-ticket gate disable (kept in sync with migrations.ts v24 ALTER):
  disabled_gates    TEXT,                 -- JSON {"uat":["e2e"],"review":["lint"]}; NULL = nothing disabled
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
-- v21 invocation-identity columns (kept in sync with migrations.ts v21 ALTERs).
-- What the gate actually invoked, so review's R7 ("did I ask a question UAT
-- didn't") can compare on the command that ran instead of the display name
-- alone. All three are NULLable and NEVER backfilled: a row recorded before
-- v21 genuinely does not know what argv produced it, and inventing one would
-- make R7 compare against a guess. `args` is a JSON array (SQLite has no array
-- type), and the one non-invocation row this table carries — 'changes',
-- recorded when the review stage opened the Changes panel — legitimately
-- leaves all three NULL forever, because it names no command.
CREATE TABLE IF NOT EXISTS gate_runs (
  id            INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS run order
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  stage_key     TEXT NOT NULL,        -- 'uat' | 'review' (GATE_STAGES)
  attempt       INTEGER NOT NULL,     -- the stage's attempt when this batch ran
  run_at        TEXT NOT NULL,        -- batch stamp: one runner invocation
  gate_name     TEXT NOT NULL,        -- lint | typecheck | test
  exit_code     INTEGER,              -- NULL = repo defines no such script (NOT a pass)
  started_at    TEXT,
  ended_at      TEXT,
  repo          TEXT,                 -- v21: the repository path invoked, NULL = pre-v21 row
  command       TEXT,                 -- v21: the binary invoked (e.g. 'npm'), NULL = pre-v21 row
  args          TEXT,                 -- v21: JSON array of argv, NULL = pre-v21 row
  skipped       INTEGER,              -- v24: 1 = resolved but deliberately not run (user disabled it for
                                       -- this ticket). NULL/0 = it ran, or a pre-v24 row. DISTINCT from
                                       -- exit_code IS NULL, which means the repo defines no such script.
  stage_run_id  INTEGER               -- v25: -> stage_runs.id, the invocation that produced this row.
                                       -- NULL = a pre-v25 row, or a batch written by a caller that opened
                                       -- no run. Never backfilled.
);
CREATE INDEX IF NOT EXISTS idx_gate_runs_ticket ON gate_runs(ticket_id, stage_key, id);

-- v25: one row per GATE RUN INVOCATION, opened BEFORE the first gate starts.
--
-- `gate_runs` is written as each gate finishes, so it answers "what has this run
-- learned so far" — but it cannot answer "is a run happening at all", which is
-- the question a stage with zero rows leaves three-way ambiguous (never started
-- / in flight / died). Only a row opened at entry can. The extension host can
-- die at any instant and process death fires no abort signal, so in-memory
-- bookkeeping (`DriverController.running`) is not evidence: a run that was
-- killed mid-flight must still be readable afterwards, as `stale`.
--
-- Append-only, like gate_runs and phase_marks: a superseded run is marked, never
-- deleted, because the fact that a previous attempt ran and was destroyed is
-- exactly what was missing.
CREATE TABLE IF NOT EXISTS stage_runs (
  id             INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS run order
  ticket_id      INTEGER NOT NULL,     -- -> tickets.id
  stage_key      TEXT NOT NULL,        -- 'uat' | 'review' (GATE_STAGES)
  attempt        INTEGER NOT NULL,     -- the stage's attempt when this run opened
  run_at         TEXT NOT NULL,        -- the batch stamp its gate_runs rows share
  status         TEXT NOT NULL,        -- 'running' | 'finished' | 'stale'
  outcome        TEXT,                 -- 'advanced' | 'blocked' | 'stopped'; NULL while running
  manifest_hash  TEXT,                 -- the gate-relevant config this run resolved from (v25)
  pid            INTEGER,              -- the process that opened it; NULL = unknown, never guessed
  started_at     TEXT NOT NULL,
  ended_at       TEXT                  -- NULL while running AND on a stale run: when it died is unknown
);
CREATE INDEX IF NOT EXISTS idx_stage_runs_ticket ON stage_runs(ticket_id, stage_key, id);

-- v26: one row per inside-process INVOCATION (gates, commit, delivery-receipt,
-- recovery…), opened before the process starts and closed at its outcome.
--
-- The inside redesign renders a stage as ordered processes, each carrying its
-- own evidence and, for AI processes, the identity that ran them. The evidence
-- tables record what FINISHED; only a row opened at entry can say a process ran
-- at all, and only that row can carry WHO ran it as it actually was at that
-- moment. `agent_name`/`provider`/`model` are an immutable identity SNAPSHOT —
-- what the execution resolved to at launch — never rewritten, never backfilled
-- into rows that predate capture.
--
-- Append-only, like stage_runs and for the same reason: a superseded run is
-- marked `stale`, never deleted, because the fact that a previous process ran
-- and was destroyed is exactly what was missing. `stale` rows keep `ended_at`
-- NULL — when a killed process stopped is genuinely unknown. `pid` is the
-- opening host's pid, used only for activation liveness; NULL = unknown, never
-- guessed.
--
-- `status` is a closed vocabulary (running | passed | failed | interrupted |
-- stale); `result_kind`/`artifact_path` carry the outcome's verdict kind and
-- artifact path, both NULLable and never backfilled.
CREATE TABLE IF NOT EXISTS process_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  stage_key     TEXT NOT NULL,        -- StageKey the process ran inside
  process_id    TEXT NOT NULL,        -- 'gates' | 'commit' | … (InsideProcessId)
  attempt       INTEGER NOT NULL,     -- the stage's attempt when the process ran
  stage_run_id  INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,  -- v25 batch stamp, if any
  agent_name    TEXT,                 -- identity snapshot: the agent that ran
  provider      TEXT,                 -- identity snapshot: claude | codex | …
  model         TEXT,                 -- identity snapshot: the resolved model id
  pid           INTEGER,              -- the opening host's pid; NULL = unknown
  status        TEXT NOT NULL CHECK (status IN ('running','passed','failed','interrupted','stale')),
  result_kind   TEXT,                 -- the outcome's verdict kind, when the process has one
  artifact_path TEXT,                 -- path of the artifact the process produced, if any
  started_at    TEXT NOT NULL,
  ended_at      TEXT                  -- NULL while running AND on a stale run
);
CREATE INDEX IF NOT EXISTS idx_process_runs_ticket
  ON process_runs(ticket_id, stage_key, process_id, id);

-- v28: the STABLE implementation run — one per impl pass, spanning provider
-- switches and resumes, opened when the first session launch intent for the
-- ticket is prepared and closed ONLY by the explicit done marker
-- (`stage impl pass`). A run is the ticket's interactive implementation as one
-- unit; a SessionEnd without the marker may interrupt it, never pass it.
CREATE TABLE IF NOT EXISTS implementation_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  -- The canonical `process_runs(stage_key='impl', process_id='session')` row —
  -- UNIQUE so the run and its process run are one-to-one. ON DELETE CASCADE:
  -- deleting the process run deletes the run (the whole run is that process).
  process_run_id INTEGER NOT NULL UNIQUE REFERENCES process_runs(id) ON DELETE CASCADE,
  attempt       INTEGER NOT NULL,     -- the impl stage's attempt when the run opened
  status        TEXT NOT NULL CHECK (status IN ('running','passed','interrupted')),
  started_at    TEXT NOT NULL,
  ended_at      TEXT                  -- NULL while running (and on an interrupted run
                                      -- whose end is known: interrupted rows DO stamp
                                      -- ended_at, unlike stale stage/process runs)
);

-- v28: a launch karst PREPARED, pending the provider's SessionStart. Terminal
-- creation is not proof the provider started, so the row stays pending until a
-- SessionStart carrying the same launch id confirms it; a terminal-creation
-- failure marks it failed. A newer launch for the same ticket/purpose
-- supersedes the older pending one. The partial unique index keeps at most one
-- pending intent per (ticket, purpose).
CREATE TABLE IF NOT EXISTS session_launch_intents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  launch_id     TEXT NOT NULL UNIQUE, -- the hook URL generation, the authenticator
  purpose       TEXT NOT NULL CHECK (purpose IN ('implementation','fix')),
  implementation_run_id INTEGER REFERENCES implementation_runs(id) ON DELETE CASCADE,
  process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  provider      TEXT NOT NULL,        -- the core the launch resolved to
  model         TEXT,
  -- v33: the CONFIGURED inside agent name a fix launch resolved to (the
  -- uat-fix/review-fix process identity), so the SessionStart can open the
  -- Fix process run with the snapshot. NULL for implementation launches and
  -- for pre-v33 fix launches — an unknown, never an invented name.
  agent_name    TEXT,
  reason        TEXT NOT NULL,        -- initial | resume | switch (LaunchReason)
  session_origin TEXT NOT NULL CHECK (session_origin IN ('new','resume','unknown')),
  provider_session_id TEXT,           -- set when the SessionStart confirms the intent
  status        TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed','superseded')),
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,                 -- confirmed/failed/superseded stamp; NULL while pending
  -- v30: the recovery round a fix launch belongs to (see recovery_rounds below).
  -- NULL for an implementation launch; REQUIRED for a fix launch — a pending
  -- Fix launch has a durable owner before its process run exists.
  recovery_round_id INTEGER REFERENCES recovery_rounds(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_launch_pending
  ON session_launch_intents(ticket_id, purpose) WHERE status = 'pending';

-- v30: one row per CAUSAL recovery round — a gate failure that entered the
-- fix loop, snapshotted atomically with the verdict that caused it.
--
-- The failing verdict, the evidence that produced it (gate rows / findings),
-- and the round itself commit together (the trigger opens inside
-- `commitGateOutcome`'s transition premutate) or not at all. The round is
-- therefore the durable owner of the recovery: `source_stage_run_id` names the
-- stage_runs batch the failure belongs to, `source_process_run_id` the AI
-- process that produced it when the source was an agent (Tester/Review; a
-- deterministic gate failure has none), `trigger_kind` the closed causal
-- vocabulary, and `max_rounds` the fix budget AS IT WAS when the failure was
-- committed — never reconstructed later from a mutable manifest or from
-- `stages.verdict` (a retry overwrites that row).
--
-- `round` is per (ticket, source_stage) and unique, so the ordering of a
-- ticket's uat failures (and its review failures) is a fact, not an array
-- position. `fix_process_run_id` links the Fix execution that answered the
-- round (opened at nudge/confirm, passed by the `stage fix pass` marker);
-- `uat_revalidation_stage_run_id`/`review_revalidation_stage_run_id` link the
-- revalidation runs that complete or fail it. A session that died mid-fix
-- marks the round `interrupted` — never a pass (the marker is the only
-- completion authority) and no additional round is consumed.
--
-- Append-only like stage_runs and process_runs: a failed/abandoned round is
-- marked, never deleted, because the fact that a recovery happened and did not
-- land is exactly what this table exists to record.
CREATE TABLE IF NOT EXISTS recovery_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  source_stage TEXT NOT NULL CHECK (source_stage IN ('uat','review')),
  source_process_id TEXT NOT NULL,  -- 'gates' | 'tester' | 'review' (closed)
  source_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  source_process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  trigger_kind TEXT NOT NULL,  -- 'gate-failure' | 'tester-verifier-failure' | 'blocking-review-findings' (closed)
  trigger_detail TEXT NOT NULL, -- the causal detail captured at failure time
  round INTEGER NOT NULL,
  max_rounds INTEGER NOT NULL,
  fix_process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  uat_revalidation_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  review_revalidation_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','fixing','revalidating','passed','failed','exhausted','interrupted')),
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_round
  ON recovery_rounds(ticket_id, source_stage, round);

-- v28: one segment per provider session inside an implementation run. The first
-- segment is confirmed by the initial launch's SessionStart; a switch opens a
-- new segment and closes the previous one; a resume reattaches the compatible
-- segment (or confirms a resume segment). `launch_intent_id` ties a confirmed
-- segment to the exact prepared launch that produced it — NOT NULL UNIQUE, so
-- a segment is confirmed at most once and never twice by two starts.
CREATE TABLE IF NOT EXISTS implementation_segments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  implementation_run_id INTEGER NOT NULL REFERENCES implementation_runs(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,        -- claude | codex | …
  model         TEXT,                 -- the resolved launch model; NULL = agent default
  provider_session_id TEXT,           -- the provider's own session id, set on confirm
  reason        TEXT,                 -- NULL (first) | 'switch' | 'resume'
  status        TEXT NOT NULL CHECK (status IN ('pending','running','closed','interrupted')),
  launch_intent_id INTEGER NOT NULL UNIQUE
                REFERENCES session_launch_intents(id) ON DELETE CASCADE,
  started_at    TEXT,                 -- set when the segment opens (or confirms)
  ended_at      TEXT                  -- closed/interrupted stamp; NULL while running
);

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
  marked_at     TEXT NOT NULL,
  -- v28 implementation-run linkage (kept in sync with migrations.ts v28 ALTERs):
  -- the stable implementation run and its segment the mark was reported inside.
  -- NULL = a pre-v28 mark, or a mark reported outside any segment. Never backfilled.
  -- ON DELETE SET NULL: deleting a run never takes its marks with it — the mark
  -- stays, its execution attribution goes.
  implementation_run_id    INTEGER REFERENCES implementation_runs(id) ON DELETE SET NULL,
  implementation_segment_id INTEGER REFERENCES implementation_segments(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_phase_marks_ticket ON phase_marks(ticket_id, stage_key, id);

-- Review findings an agent (or, per the schema, a human) reported about a
-- ticket's diff — review's Lane B evidence (§6.7 `review_findings`).
-- APPEND-ONLY, exactly like gate_runs and phase_marks: a finding is an event,
-- many per stage, and `stages` is keyed (ticket_id, stage_key) and overwritten
-- by a retry, so this table is the only place a prior attempt's findings
-- survive. Never UPDATEd.
--
-- The identity is the surrogate `id`, not a natural key — same reasoning as
-- gate_runs: a fail->fix->pass cycle files two invocations under one
-- `attempt`, so (ticket, attempt) is not unique. `attempt` is read BEFORE any
-- bump, so a batch is filed under the attempt that produced it. `run_at` is
-- the batch stamp shared by every finding of one review invocation;
-- `latestFindingBatch` (store/reviewFindings.ts) picks by greatest `run_at`,
-- never by array position (the `inside/gates.ts:19-30` rule) — insertion
-- order is not a query contract.
--
-- `severity` is TEXT rather than an enum (SQLite has none) but is a CLOSED
-- vocabulary — critical | high | medium | low | info, `manifest/types.ts`'s
-- `Severity` — enforced where untrusted model output is parsed (a later task
-- drops an unrecognized severity rather than storing it). `recordFindings`
-- itself is typed against that union rather than re-checking at runtime, so a
-- value outside it can only arrive from a foreign write or a future karst's
-- wider vocabulary — which reads degrade on rather than throw.
--
-- `file` carries no absolute path and no `..` segment (validated where the
-- finding is parsed, not here); NULL = not file-scoped. `line` NULL = whole
-- file. `repo` is NOT NULL — '' states "not repo-scoped" rather than using
-- NULL for two different absences.
--
-- v27 `process_run_id` (kept in sync with migrations.ts v27 ALTER): the
-- process_runs row of the review invocation that produced this batch. NULL = a
-- pre-v27 row, or a batch whose caller named no process. Never backfilled.
-- ON DELETE SET NULL: a deleted run never takes its findings with it — the
-- finding stays, its execution attribution goes.
--
-- No column can hold the diff itself, for the same reason `token_usage` has
-- no text column: this table is read on the review panel's render path.
CREATE TABLE IF NOT EXISTS review_findings (
  id          INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS report order
  ticket_id   INTEGER NOT NULL,     -- -> tickets.id
  process_run_id INTEGER,           -- v27: -> process_runs.id; NULL = no process (or legacy)
  attempt     INTEGER NOT NULL,     -- review's attempt when this batch landed
  run_at      TEXT NOT NULL,        -- batch stamp: one review invocation
  severity    TEXT NOT NULL,        -- critical | high | medium | low | info (closed set)
  repo        TEXT NOT NULL,        -- worktrees.repo; '' when not repo-scoped
  file        TEXT,                 -- repo-relative, validated; NULL = not file-scoped
  line        INTEGER,              -- NULL = whole file
  title       TEXT NOT NULL,        -- capped at TITLE_MAX, single line
  detail      TEXT NOT NULL,        -- capped at DETAIL_MAX
  source      TEXT NOT NULL,        -- 'agent' | 'human'
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_findings_ticket
  ON review_findings(ticket_id, run_at, id);
-- v27: per-process-run evidence reads (one review invocation's findings).
CREATE INDEX IF NOT EXISTS idx_review_findings_process
  ON review_findings(process_run_id, id);

-- v31: one row per OBSERVATION the UAT Tester process (Task 8) reported about a
-- ticket's behavior — advisory, structured evidence ONLY. The Tester is an AI
-- process, so unlike `gate_runs` (deterministic exit codes) its rows can never
-- pass, fail, transition, or spend a recovery round by themselves: the ordinary
-- UAT gates stay authoritative, and the optional deterministic
-- `uat.testerVerifier` boundary is the sole Tester-specific verdict source.
--
-- APPEND-ONLY like review_findings and for the same reason: an observation is
-- an event produced by one process invocation, and `stages` (keyed
-- (ticket_id, stage_key)) is overwritten by a retry. `process_run_id` is
-- REQUIRED — an observation that cannot be attributed to a Tester execution is
-- dropped, never stored against an invented one. `repo` is NULLable ("not
-- repo-scoped") while review_findings uses '' for that, because the Tester
-- prompt names its target explicitly and an unattributed observation must not
-- read as belonging to the first repository in the list.
--
-- `severity` is the same closed `Severity` vocabulary as review_findings,
-- enforced where untrusted model output is parsed (workflow/uat/tester.ts via
-- review's parseFindings). `file_path` carries no absolute path and no `..`
-- segment (validated where parsed); NULL = not file-scoped. `line` NULL =
-- whole file. `title` is capped and single-line like review's. There is no
-- `detail` column: an observation's row is a title plus a location, and
-- `token_usage` is the evidence table that carries what the call cost.
CREATE TABLE IF NOT EXISTS uat_findings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id      INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  process_run_id INTEGER NOT NULL REFERENCES process_runs(id) ON DELETE CASCADE,
  repo           TEXT,
  severity       TEXT NOT NULL,        -- critical | high | medium | low | info (closed set)
  title          TEXT NOT NULL,        -- capped at TITLE_MAX, single line
  file_path      TEXT,                 -- repo-relative, validated; NULL = not file-scoped
  line           INTEGER,              -- NULL = whole file
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uat_findings_ticket ON uat_findings(ticket_id, id);
-- Per-process-run evidence reads (the inside view's Tester evidence).
CREATE INDEX IF NOT EXISTS idx_uat_findings_process ON uat_findings(process_run_id, id);

-- v32: the durable per-repository SHIP SAGA (Task 9). A ship is a sequence of
-- irreversible external operations (commit, push, PR-description, PR creation)
-- per repo, and git/GitHub's answer to an operation only exists AFTER the side
-- effect happened — a crash mid-saga cannot be re-approximated by probing.
-- These four tables make each operation RECONCILABLE instead: the run, the
-- per-repo steps it walked, the typed ownership rows persisted BEFORE each
-- external touch, and the commits it created (or found already present).
--
-- Evidence posture like stage_runs/process_runs: append-only, opened at entry
-- (`running`/`preparing`), closed at outcome, and a late writer is never
-- allowed to overwrite a terminal state (every transition is guarded on the
-- row still being where the transition expects it).
--
-- `ship_operation_intents.pre_state_json` is ALWAYS present before anything
-- touches git/GitHub; `intent_json` is NULL only while a Commit row is
-- `preparing`. Both are parsed through closed TypeScript unions keyed by
-- `step` (src/store/shipRuns.ts) — malformed/unknown data reads as `ambiguous`,
-- never as permission to prepare, clean up, or repeat an operation.
-- `operation_key` is globally UNIQUE: a crash-and-rerun re-prepares the SAME
-- operation, so the durable ownership row is returned, never duplicated.
CREATE TABLE IF NOT EXISTS ship_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  -- v34 liveness evidence: the extension host that opened the run, so an
  -- activation sweep can tell a ship that died with its host from one another
  -- LIVE window is still executing. NULL = unknown (a pre-v34 run) and is
  -- never read as "alive" — the stranded-ship sweep resumes a NULL-pid
  -- running run, while `reconcileShipRuns` leaves it strictly alone.
  -- Placed LAST, matching where the migration's ALTER TABLE ADD COLUMN
  -- necessarily puts it on an upgraded DB (SQLite always appends).
  pid INTEGER
);
CREATE TABLE IF NOT EXISTS ship_repo_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_run_id INTEGER NOT NULL REFERENCES ship_runs(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('commit','push','describe','pr')),
  status TEXT NOT NULL CHECK (status IN ('running','passed','failed','note')),
  detail TEXT NOT NULL,
  pr_number INTEGER,
  existed_before_ship INTEGER,
  process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  -- v32 ownership linkage: -> ship_operation_intents.id, the durable row that
  -- authorizes this step's preparation. NULL = no preparation has begun (a
  -- running step with no matching intent must never authorize one).
  -- Placed LAST, matching where the migration's ALTER TABLE ADD COLUMN
  -- necessarily puts it on an upgraded DB (SQLite always appends).
  operation_intent_id INTEGER REFERENCES ship_operation_intents(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS ship_operation_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_run_id INTEGER NOT NULL REFERENCES ship_runs(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('commit','push','describe','pr')),
  operation_key TEXT NOT NULL UNIQUE,
  pre_state_json TEXT NOT NULL,
  intent_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('preparing','prepared','applied','reconciled','failed','ambiguous')),
  created_at TEXT NOT NULL,
  prepared_at TEXT,
  applied_at TEXT,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS ship_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_run_id INTEGER NOT NULL REFERENCES ship_runs(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  message TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('before-ship','created-by-ship'))
);
CREATE INDEX IF NOT EXISTS idx_ship_run_ticket ON ship_runs(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_ship_step_run ON ship_repo_steps(ship_run_id, id);
CREATE INDEX IF NOT EXISTS idx_ship_commit_run ON ship_commits(ship_run_id, id);

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
--
-- v27 `process_run_id` (kept in sync with migrations.ts v27 ALTER): the inside
-- process run this call belongs to (gates, commit, delivery-receipt…). NULL =
-- a call made before the inside redesign, or by a caller that named no process
-- (a ticket-form draft, an interactive session). Never backfilled into legacy
-- rows. ON DELETE SET NULL: deleting a run must never take the ledger's spend
-- with it — the count stays, its execution attribution goes.
CREATE TABLE IF NOT EXISTS token_usage (
  id                 INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS call order
  project_id         INTEGER,              -- -> projects.id; NULL = unscoped (recovery only)
  ticket_id          INTEGER,              -- -> tickets.id; NULL = not yet a ticket (draft)
  process_run_id     INTEGER,              -- v27: -> process_runs.id; NULL = no process (or legacy)
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
  recorded_at        TEXT NOT NULL,        -- ISO-8601; what every time-range filter cuts on
  -- v28 implementation-segment linkage (kept in sync with migrations.ts v28 ALTER):
  -- the implementation segment the call was made inside. NULL = a call made
  -- outside a segment (a draft, a gate, a pre-v28 call). Never backfilled.
  -- ON DELETE SET NULL: deleting a segment never takes the ledger's spend with
  -- it — the count stays, its attribution goes.
  implementation_segment_id INTEGER REFERENCES implementation_segments(id) ON DELETE SET NULL,
  -- v29 interactive-sample linkage (kept in sync with migrations.ts v29 ALTER):
  -- the interactive_usage_samples row this measured delta was computed from.
  -- NULL = a call recorded by an instrumented headless run, or a pre-v29 row.
  -- Never backfilled. ON DELETE SET NULL: deleting a sample never takes the
  -- ledger's spend with it — the count stays, its measurement source goes.
  interactive_usage_sample_id INTEGER REFERENCES interactive_usage_samples(id) ON DELETE SET NULL,
  -- v35 graph linkage (kept in sync with migrations.ts v35 ALTER):
  -- the planner/node run the call was made inside. NULL = a call outside the
  -- graph runtime, or a pre-v35 row. Never backfilled. ON DELETE SET NULL:
  -- deleting graph history never takes the ledger's spend with it — the count
  -- stays, its attribution goes.
  approach_planner_run_id INTEGER REFERENCES approach_planner_runs(id) ON DELETE SET NULL,
  approach_node_run_id    INTEGER REFERENCES approach_node_runs(id) ON DELETE SET NULL
);
-- The aggregation index set. Every stats query filters on (project_id,
-- recorded_at) and then groups by one of ticket / call_site / model, so each
-- grouping gets a covering leading edge — the rollups stay in SQLite as the row
-- count grows instead of becoming an in-memory scan.
CREATE INDEX IF NOT EXISTS idx_token_usage_project_time ON token_usage(project_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_ticket ON token_usage(ticket_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_site ON token_usage(project_id, call_site, recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(project_id, model, recorded_at);
-- v27: per-process-run evidence reads (the inside view's spend for one process),
-- `id` second so one run's rows come back in call order.
CREATE INDEX IF NOT EXISTS idx_token_usage_process ON token_usage(process_run_id, id);
-- v28: per-implementation-segment evidence reads, `id` second for call order.
CREATE INDEX IF NOT EXISTS idx_token_usage_segment ON token_usage(implementation_segment_id, id);
-- v29: the measured interactive delta rows; `id` second for observation order.
-- `interactive_usage_sample_id` is kept in sync with migrations.ts v29 ALTER.
CREATE INDEX IF NOT EXISTS idx_token_usage_interactive_sample
  ON token_usage(interactive_usage_sample_id) WHERE interactive_usage_sample_id IS NOT NULL;

-- v29: one row per measured CUMULATIVE token observation of an interactive
-- provider session (Task 5). The provider bridge POSTs a UsageUpdate carrying
-- numeric counts and a stable event id; the appender (store/interactiveUsageSamples.ts)
-- persists the sample HERE before computing any delta, so a restart between
-- observations cannot lose the baseline decision.
--
-- The baseline scope is the PROVIDER SESSION: (provider, provider_session_id)
-- is the same conversation across every Karst process and segment, and a later
-- sample subtracts the session's last persisted observation wherever it was
-- recorded. `process_run_id` (the Karst process bound to the session when the
-- sample landed) is REQUIRED — an observation that cannot be attributed to a
-- process is dropped, never guessed at. `implementation_segment_id` refines the
-- attribution for an implementation session; a fix session has none.
--
-- `counter_epoch` is the provider's counter generation: a decrease in any
-- counter opens a new epoch and the reset observation is counted from zero
-- (full non-negative counts) only when the binding proves continuous
-- instrumentation. `baseline_only = 1` marks an observation persisted as the
-- next delta's predecessor that wrote no `token_usage` row — a resumed/adopted
-- session's first observation, or an unprovable reset.
--
-- Append-only evidence: nothing here is ever UPDATEd. A duplicate event id is
-- rejected by the unique index, never overwritten.
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
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_usage_event
  ON interactive_usage_samples(provider, provider_session_id, source_event_id);
CREATE INDEX IF NOT EXISTS idx_interactive_usage_segment
  ON interactive_usage_samples(implementation_segment_id, id);
CREATE INDEX IF NOT EXISTS idx_interactive_usage_process
  ON interactive_usage_samples(process_run_id, id);
CREATE INDEX IF NOT EXISTS idx_interactive_usage_provider_session
  ON interactive_usage_samples(provider, provider_session_id, id);

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

-- v38 (Slice 4 Task 6): the node-override table gains the category-specific
-- columns — `kind` (profile/provider/model/effort/prompt), the `value` JSON,
-- and `created_at` — plus the `(revision_id, node_id, kind)` uniqueness that
-- scopes an override to ONE node in ONE revision (an override never carries
-- into a replanned revision N+1, whose revision_id differs). The legacy
-- provider/model/effort/profile columns remain as the v35 placeholder's
-- record; `value` is the operative payload. The claim CAS is the node run's
-- status (editable only in ready/blocked/failed-to-launch), never the row.

-- v35 graph tables (Slice 2, design "Persistence") — byte-identical to
-- migrations.ts GRAPH_MIGRATION_DDL (db.test.ts pins the equality).
--
-- v39 (Slice 5 Task 1) adds two columns to these tables and one ledger table
-- at the end: `approach_graph_runs.workspace_bytes` is the graph run's durable
-- aggregate node-workspace byte total (measured against
-- `graph.limits.maxAggregateWorkspaceBytes`, incremented on creation, negated
-- never below zero on cleanup); `approach_node_runs.base_heads` is the
-- canonical integration heads observed when the activation was claimed (JSON
-- of `{domainKey, commit}`); `approach_graph_workspaces` is the per-workspace
-- ledger that keeps the negations exact.
--
-- v40 (Slice 5 Task 3) adds the scheduler shape: `approach_graph_runs.
-- active_processes` is the coordinator's own accounting of the external-process
-- ceiling (`graph.limits.maxParallel`), reserved in the claim and released when
-- a process provably ends; `approach_node_deferrals` is the deferral ledger —
-- one row per ready-but-blocked node carrying the refusal reason and
-- `wait_since`, so Inside can show that deliberate serialization is not a
-- scheduler defect and bounded aging can promote an old waiter.

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

-- v39 (Slice 5 Task 1): the durable per-workspace ledger. One row per clone
-- created for a node run, with the byte count it contributes to the graph
-- run's `workspace_bytes` total; cleanup negates the total by the sum of the
-- rows it deletes, so the ledger is what keeps the negations exact.
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

-- v42 (the agent test driver): two test-only tables, written ONLY by the
-- `karst test` CLI verb — no production code reads or writes them, so a
-- normal workflow's registry never accumulates rows here.
--
-- `test_logs` mirrors what the extension would have written to the output
-- channel as structured rows, so a test can assert on driver/gate/hook
-- logging the way an agent reads `context`. `meta` is a JSON blob for
-- structured data (a gate's stdout/stderr, a diff, …).
CREATE TABLE IF NOT EXISTS test_logs (
  id            INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS log order
  ticket_id     INTEGER,              -- -> tickets.id; NULL = not ticket-scoped
  level         TEXT NOT NULL,        -- debug | info | warn | error
  module        TEXT NOT NULL,        -- [driver], [gate], [agent:claude], …
  message       TEXT NOT NULL,
  meta          TEXT,                 -- JSON blob for structured data
  recorded_at   TEXT NOT NULL         -- ISO-8601; what --since cuts on
);
CREATE INDEX IF NOT EXISTS idx_test_logs_ticket ON test_logs(ticket_id, id);

-- Hook events the driver dispatched (a subset of what dispatchHook processes),
-- recorded AFTER the dispatch so `agent_state_after` reflects the applied
-- state. Append-only evidence like gate_runs: an event is a fact, never edited.
CREATE TABLE IF NOT EXISTS test_hooks (
  id                INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS dispatch order
  ticket_id         INTEGER,              -- -> tickets.id
  event             TEXT NOT NULL,        -- SessionStart | SessionEnd | Stop | …
  session_id        TEXT,
  payload           TEXT,                 -- JSON of the full hook payload
  agent_state_after TEXT,                 -- what agent_state was set to
  recorded_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_hooks_ticket ON test_hooks(ticket_id, id);
