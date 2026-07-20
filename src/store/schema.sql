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
  -- v2 onboarding columns (kept in sync with migrations.ts v2 ALTERs):
  description       TEXT,                 -- ticket requirements / acceptance criteria
  brief             TEXT,                 -- synthesized context brief (from fetch)
  source_ref        TEXT,                 -- board task id/url the ticket was fetched from
  source_fetched_at TEXT,                 -- when the source was last fetched
  approach          TEXT,                 -- chosen development approach id
  agent             TEXT,                 -- chosen single-subagent id (nullable)
  selected_repos    TEXT,                 -- JSON array of confirmed service names
  -- v3 lifecycle column (kept in sync with migrations.ts v3 ALTER):
  archived_at       TEXT,                 -- soft-delete timestamp; NULL = active
  -- v5 model column (kept in sync with migrations.ts v5 ALTER):
  model             TEXT,                 -- per-ticket launch model id; NULL = inherit default
  -- v6 project column (kept in sync with migrations.ts v6 ALTER):
  project_id        INTEGER,              -- -> projects.id; NULL = unassigned (pre-v6 ticket)
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stages (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  stage_key     TEXT NOT NULL,        -- StageKey (no `fetch` in MVP, C1)
  status        TEXT NOT NULL,        -- pending | running | passed | failed | skipped
  attempt       INTEGER NOT NULL DEFAULT 0,  -- review/fix loop iteration
  verdict       TEXT,
  artifact_path TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  PRIMARY KEY (ticket_id, stage_key)
);

CREATE TABLE IF NOT EXISTS worktrees (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  repo          TEXT NOT NULL,
  path          TEXT NOT NULL,
  branch        TEXT,
  base_ref      TEXT,                 -- branch point, for staleness (§9)
  deps_mode     TEXT NOT NULL DEFAULT 'inherited',  -- inherited | local (§8.2)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS port_allocations (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  service       TEXT NOT NULL,
  port_name     TEXT NOT NULL,
  port          INTEGER NOT NULL,
  UNIQUE (port)                       -- the correctness guard under concurrency
);

CREATE TABLE IF NOT EXISTS baseline_refs (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  service       TEXT NOT NULL,
  PRIMARY KEY (ticket_id, service)
);

CREATE TABLE IF NOT EXISTS servers (
  id            INTEGER PRIMARY KEY,
  ticket_id     INTEGER,              -- NULL => baseline singleton
  service       TEXT NOT NULL,
  host          TEXT,
  port          INTEGER,
  pid           INTEGER,
  status        TEXT NOT NULL,        -- running | stopped
  log_path      TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prs (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  repo          TEXT NOT NULL,
  number        INTEGER,
  url           TEXT,
  status        TEXT
);
