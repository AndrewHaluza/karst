# Projects — working on several projects in parallel from separate IDE windows

Ticket: `869e49kq0`

> **Outcome:** Option C was chosen and implemented (§9 records what shipped).
> Sections 1–8 are the original research, kept as the rationale.

## 1. What the ticket actually asks for

Today Karst assumes **one project per user**. The ask is to make a second (third, …)
VS Code/Cursor window, opened on a *different* repo stack, behave as an independent
Karst workspace — its own tickets, its own manifest, its own running sessions — while
the two windows are live at the same time.

Two sub-goals hide inside that, and they have different answers:

- **Isolation** — window on project A must not show, mutate, or drive project B's tickets.
- **Aggregation** (optional) — the user may still want one place to see "everything I
  have in flight across projects". Isolation alone kills this; a `projects` entity keeps it.

Which of the two we commit to is the single decision that picks the option below.

## 2. Current state — what is global and what is per-window

| Thing | Scope today | Where |
|---|---|---|
| SQLite DB `karst.db` | **global** (per extension, shared by every window) | `extension.ts:145-147` — `context.globalStorageUri` |
| Manifest `karst.yml` | per-window (workspace folder) | `extension/manifestResolve.ts:20-25` |
| Approaches / agents dirs | per-window (workspace folder) | `manifestResolve.ts:29-46` |
| Worktrees | per-project on disk (`<repo>/.karst/worktrees/…`) | manifest-driven |
| Hook endpoint HTTP port | per-window, **ephemeral** | `hooks/endpoint.ts:78-86` |
| `karst-hooks.settings.json` | **global, single path** | `agent/settings.ts:52-56` + `extension.ts:184,194` |
| Artifacts `artifacts/<ticketId>` | global, keyed by global ticket PK — already safe | `extension.ts:608` |
| Port allocations | global, `UNIQUE(port)` across the whole DB | `store/schema.sql:51-57` |

So: **all durable state is already global; all configuration is already per-window.**
The seam is exactly at the DB, and nothing in the schema records which project a
ticket belongs to.

## 3. Concrete breakages when two windows are open

Ranked by how badly they bite.

1. **Ticket list is not scoped.** `listTickets` (`store/tickets.ts:296-303`) selects
   every row; the sidebar and dashboard in project A show project B's tickets. Acting
   on one of them spins worktrees against A's manifest → wrong repo paths, or a hard
   failure if the service name doesn't exist in A's manifest. This is the headline bug.
2. **Shared hook-settings file, last-writer-wins.** Both windows write the *same*
   `karst-hooks.settings.json` with their *own* ephemeral port. Steady state is fine
   (each agent captured the file at launch), but two launches that interleave can hand
   window A's agent window B's port — hooks then land on the wrong extension host, which
   drives the ticket and opens a terminal in the wrong IDE window.
3. **No cross-window invalidation.** Refresh is purely event-driven from in-window
   commands (`extension.ts` `provider.refresh()` call sites). Window B's writes are
   invisible in window A until the user hits refresh. Any shared-DB option must add a
   change signal.
4. **`reconcileOnStart` sweeps globally** (`recovery/reconcile.ts:91-127`). Opening a
   second window re-derives `stage_current` for *every* ticket, including the other
   project's. It is idempotent and the server sweep is pid-liveness-guarded
   (`isAlive`, line 115), so this is currently benign — but it is a landmine for any
   future non-idempotent recovery step.
5. **Ticket key collisions.** `getTicketByKey` (`tickets.ts:132`) assumes `key` is
   globally unique. Two projects on the same tracker prefix, or two manual `TASK-1`s,
   silently alias.
6. **Synchronous multi-process writes.** better-sqlite3 defaults `busy_timeout` to
   5000 ms (`node_modules/better-sqlite3/lib/database.js:34`) and is *synchronous* —
   a contended write can block the extension host for up to 5 s. WAL makes this rare;
   long write transactions (`reconcileOnStart` wraps a whole sweep) make it possible.

Note what is **not** broken: port allocation is already cross-project-safe precisely
*because* the DB is global. Any option that splits the DB must re-solve it.

## 4. Cross-cutting sub-problems (every option must answer these)

- **P1 Project identity.** What is a project keyed by? Candidates: workspace folder
  path, manifest absolute path, or an explicit `id:` field added to `karst.yml`. Path
  keys break when the user moves the repo; an explicit manifest id survives moves and
  is the only one that works if two windows open the same repo at different paths
  (worktrees!). Recommend: `id` in `karst.yml`, generated on scaffold, path as fallback.
- **P2 Ticket ownership.** Which window is allowed to drive a ticket (spawn terminals,
  run gates)? Must be the window whose manifest produced the worktrees. Needs an
  explicit owner, not "whoever got the hook".
- **P3 Hook routing.** Per-window settings file + stable mapping from session → endpoint.
- **P4 Live updates.** Cross-window change notification.
- **P5 Port uniqueness.** Global today; must stay global (localhost is one namespace)
  regardless of how ticket storage is split.
- **P6 Migration.** Existing users have one global DB full of unscoped tickets.

## 5. Options

### A — Status quo + scoping filter only (minimal)

Add `project_id` to `tickets`, derive it from the manifest at create time, filter every
list query. No `projects` table, no daemon.

- **Effort:** small. One migration (v6), one column, filter in `listTickets` /
  `listArchivedTickets` / `getTicketByKey`, one resolver for "current project id".
- **Solves:** breakage 1 and 5.
- **Leaves open:** P3, P4 (2 and 3 stay broken).
- **Verdict:** necessary groundwork under any option, insufficient alone.

### B — Per-workspace database

Move the DB from `globalStorageUri` to `storageUri` (VS Code's per-workspace storage).
Each window gets its own `karst.db`. No project entity at all.

- **Pros:** strongest isolation, near-zero schema change, no write contention, no
  cross-window invalidation needed (nothing is shared), hook-settings file naturally
  becomes per-workspace and P3 dissolves.
- **Cons:**
  - **Breaks P5.** Port uniqueness is enforced by `UNIQUE(port)` *within one DB*. Split
    the DB and two projects can hand out port 4310 twice. Needs either a separate global
    port registry (a lock file or a tiny shared DB — reintroducing a global store), or a
    documented convention that each manifest declares a disjoint `portRange`. The latter
    is manual and error-prone but is honestly quite defensible for a single-user tool.
  - Aggregation is impossible.
  - `storageUri` is `undefined` when no folder is open — needs a fallback.
  - Migration: existing global tickets must be partitioned into per-workspace DBs, or
    abandoned. Artifacts (`globalStorage/artifacts/<id>`) key on a PK that is no longer
    globally unique → must move under the per-workspace dir too.
- **Verdict:** simplest correct isolation, at the cost of the one thing the global DB
  was buying us. Pick this if aggregation is explicitly out of scope.

### C — Global DB + first-class `projects` table (recommended)

Keep one DB. Add:

```sql
CREATE TABLE projects (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,   -- from karst.yml `id:`
  name        TEXT,
  root_path   TEXT,                   -- last-known workspace folder, advisory only
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE tickets ADD COLUMN project_id INTEGER;  -- NULL = legacy/unassigned
```

Window binds to a project row on activation via P1's manifest id (upsert on first sight).
Every list query filters on it; the dashboard can optionally offer an "all projects" facet.

- **Pros:** keeps P5 for free; enables aggregation; single migration story; `key`
  uniqueness becomes `(project_id, key)`; artifacts keep working unchanged.
- **Cons:** must still solve P3 and P4 (see §6, both are small and independent); the
  contention note in breakage 6 stands.
- **Effort:** medium. Migration v6, a `store/projects.ts`, a `currentProject()` resolver
  next to `manifestCache`, threading `projectId` through `createTicket` + the three list
  queries, and a `project_id IS NULL` back-compat path for legacy rows.
- **Verdict:** best ratio. It is option A plus a real entity, and it is the only option
  that keeps the door open for a cross-project board.

### D — Split store: global registry + per-project ticket DBs

Global DB holds `projects` + `port_allocations` only; each project gets its own DB for
tickets/stages/worktrees/servers.

- **Pros:** isolation of B with the port safety of C.
- **Cons:** two stores, two migration ladders, two open handles, cross-store joins for
  any aggregate view, and `openReadonlyStore` / the `karst context` CLI now need both
  paths. Materially more complex than C for a benefit (write isolation) that C's
  `busy_timeout` already makes mostly theoretical at single-user scale.
- **Verdict:** only if contention proves real in practice.

### E — Karst daemon (single writer)

One background process owns the DB and the hook endpoint; windows are thin clients over
local HTTP/IPC. Note `store/schema.sql:2` already says *"The daemon is the sole writer"* —
this was the original architecture and was dropped for MVP.

- **Pros:** solves P2, P3, P4, P5 and breakage 6 all at once and properly. One stable hook
  port forever (no more rewriting a settings file). Push-based live updates. Tickets can
  keep running while every window is closed.
- **Cons:** large. Process lifecycle (spawn, health, upgrade, orphan cleanup), an IPC
  protocol, and a distribution story for a VS Code extension that must not leave stray
  daemons. Also the biggest departure from the "host-agnostic pure logic + thin vscode
  shell" invariant.
- **Verdict:** the right long-term shape, wrong size for this ticket. C is a strict subset
  of the work E would need anyway (a `projects` entity is required either way), so C is
  not a detour.

## 6. Sub-fixes needed regardless (small, independent, land first)

- **P3 hook routing:** name the settings file per window —
  `karst-hooks.<port>.settings.json` (or per project+window). One-line change in
  `agent/settings.ts:52`; removes the interleaving race and lets old files be swept.
- **P4 live updates:** cheapest is a poll-on-focus — refresh the sidebar/dashboard on
  `window.onDidChangeWindowState` when the window regains focus, plus a low-frequency
  timer while visible. A file watcher on the DB's `-wal` file is more precise but fires
  noisily. A daemon (E) is the only clean push.
- **P2 ownership:** record the owning project on the ticket (falls out of C) and refuse
  to spin/drive a ticket whose `project_id` doesn't match the window's.
- **Reconcile scoping:** pass the project id into `reconcileOnStart` once C exists.

## 7. Recommendation

**Option C, plus the P3 and P4 sub-fixes, staged:**

1. **Stage 1 (unblocks the ticket):** migration v6 — `projects` table + `tickets.project_id`;
   `id:` field in `karst.yml` (new manifest field → remember the `writeManifest` overlay
   checklist in CLAUDE.md, or Save drops it); `currentProject()` resolver; filter the three
   list queries and `getTicketByKey`; legacy `NULL` rows adopted by the first project that
   claims their `root_path`.
2. **Stage 2:** per-window hook settings filename; ownership guard on spin/drive;
   scope `reconcileOnStart`.
3. **Stage 3:** refresh-on-focus, and an optional "All projects" facet in the sidebar.

Reasons over B: port uniqueness is a real correctness property that B silently gives up,
and B forecloses aggregation. Reasons over E: E is 5–10× the work and C is a prerequisite
for it, not a competing design.

## 8. Open questions for the user

1. **Is a cross-project "everything in flight" view wanted?** Yes → C. Firmly no → B is
   cheaper and stronger.
2. **Project identity:** add an `id:` to `karst.yml`, or key on workspace path? (Recommend
   `id:` — path keys break on repo moves.)
3. **Legacy tickets:** adopt them into the first project that matches, or leave them in an
   "Unassigned" bucket the user reassigns by hand?
4. **Should tickets keep running with no window open?** If yes, that forces E eventually
   and changes the staging.

## 9. What shipped

Option C, with the decisions from §8 answered as: manifest `id:` for identity, and
adopt-on-first-bind for legacy tickets.

| Breakage (§3) | Status |
|---|---|
| 1 · unscoped ticket list | **fixed** — `projects` table + `tickets.project_id` (schema v6); `ProjectScope` threaded through `listTickets`, `listArchivedTickets`, `getTicketByKey`, `createTicket` |
| 2 · shared hook-settings file | **fixed** — filename keyed by the window's port, with an age-based sweep |
| 3 · no cross-window invalidation | **fixed** — sidebar refreshes on `onDidChangeWindowState` focus |
| 4 · global `reconcileOnStart` | **unchanged, deliberate** — it is idempotent and pid-guarded; scoping it would stop it healing projects whose window is closed |
| 5 · ticket key collisions | **fixed** — key is unique per project; the CLI disambiguates via `--manifest` |
| 6 · sync multi-process writes | **not addressed** — 5 s `busy_timeout` stands; revisit only if it bites (option D/E) |

Also landed: the activation sweep is scoped, so a window only drives tickets whose
services its own manifest defines (P2 ownership).

**Deferred deliberately:**
- The "All projects" facet. The store supports it (an unscoped query is the whole
  feature); no UI was added, since nobody has asked to look across projects yet.
- A project-management surface — rename, delete, reassign a ticket. Today a project row
  appears on first bind and is never edited. The gap that will be felt first: a legacy
  ticket stranded unassigned (because a second project bound first) has no UI to rescue
  it; it needs a manual `UPDATE tickets SET project_id`.
- Per-project `portRange` validation. Ranges are still global and unenforced across
  manifests, so two projects can declare overlapping windows; `UNIQUE(port)` catches the
  actual collision at allocation time, but the error surfaces late and reads as
  exhaustion rather than misconfiguration.
