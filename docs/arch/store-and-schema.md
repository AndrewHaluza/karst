# The store: SQLite, projects, and schema changes

The registry is shared by every IDE window, so every rule here is about scoping and about changing the schema without stranding a row. Related: `docs/arch/cli.md` (the CLI asserts the version but cannot migrate), `docs/arch/stages-and-gates.md` (the evidence tables), `docs/arch/model-store-workflow-layering.md` (why `model/artifacts.ts` below is allowed to call live `store` reads).

## Contents

- SQLite is source of truth
- Projects scope the board across IDE windows
- Global storage is shared by every window
- Graph-run state writes have one boundary
- The artifact shelf is a READ over existing evidence
- The per-ticket base-branch columns
- The per-ticket env overrides column
- One worktrees row per (ticket, path)
- v64: sub-task autostart and parent–child mailbox schema
- New schema column checklist

## SQLite is source of truth

SQLite is source of truth; `reconcileOnStart`/`deriveStageCurrent` re-derive on boot.

## Projects scope the board across IDE windows

The DB lives in *global* storage — every window shares it — so every ticket query MUST be scoped or window A lists/drives window B's tickets. Identity is `projects.slug`, from manifest `id:` else a path-derived fallback (`project/slug.ts`); `bindProject` (`project/bind.ts`) registers it at activation. Pass `{ projectId }` to `listTickets`/`listArchivedTickets`/`getTicketByKey`/`createTicket`; unscoped is the deliberate all-projects view (recovery only). Ticket `key` is unique **per project**, not globally. Legacy `project_id IS NULL` rows are adopted once per install, guarded by a globalState flag AND "only one project exists".

## Global storage is shared by every window

Global storage is shared by every window: anything written there needs a per-window key. `writeHookSettings` names its file by the window's ephemeral hook port for exactly this reason (`agent/settingsSweep.ts` reaps old ones). Same trap in `globalState`: the remembered hook port lives in **`workspaceState`** — each window binds its own port, and a global key let the second window's EADDRINUSE fallback overwrite the first's, so the first could never reclaim the port its live sessions still post to.

## Graph-run state reads and writes have one boundary

Every in-process write to `approach_graph_runs`, `approach_node_runs`, and
`approach_planner_runs` goes through `src/store/graph/` (`graphRuns.ts`,
`nodeRuns.ts`, `plannerRuns.ts`) — status transitions through
`transitions.ts`'s `casStatus`, column writes through the named helpers next to
them (`markGraphRunBlocked`, `setNodeRunFailure`,
`setPlannerRunSubmittedSnapshot`, …), and the ticket-delete cascade through
`deleteGraphRunData`. The graph runtime (`approaches/graph/**`),
`extension.ts`, and `store/tickets.ts` contain no raw SQL against the three
tables, so a new column or status is added to the store module and the schema,
never to a scattered call site (NDL-38).

Reads are centralized the same way (NDL-60): every raw read of the three tables
in the runtime, `extension.ts`, the Inside dashboard, and the workflow boundary
goes through a named read helper next to the full-row reads (`graphRunById`,
`nodeRunById`, `plannerRunById`) — `graphRunStatus`, `graphRunTicketId`,
`latestGraphRunForTicket`, `nodeRunsForGraphRun`,
`countNodeRunsForRevisionNode`, `nextVisitNumber`, `plannerRunCompileAttempt`,
`submittedPlannerRunForGraphRun`, … — and call sites narrow with
`Pick<GraphRunRow, …>` / `Pick<NodeRunRow, …>` / `Pick<PlannerRunRow, …>` rather
than declaring their own drifting row interfaces. A new column or status is
therefore added to the store module and the schema, never to a repo-wide grep.

Two deliberate, documented exceptions remain:

- **The `karst` CLI's authenticated reads and UPDATEs** (`src/cli/node.ts`,
  `src/cli/graph.ts`, `src/cli/stage.ts`) stay beside their parse path — they
  fold ticket/project scoping, generation identity, and the wrong-attempt check
  into one conditional statement, and keeping that in the CLI is the security
  property `docs/arch/cli.md` describes. The CLI opens its own `node:sqlite`
  handle and never imports the extension's `store/graph` module.
- **Reporting aggregates** (`src/diagnostics/storeEvidence.ts`,
  `src/store/metrics/cost.ts`, `src/store/tokenUsage.ts`,
  `src/store/interactiveUsageSamples.ts`) stay as read-only joins over the run
  tables: they aggregate cost/token/profile facts across `token_usage`,
  `process_runs`, and the run rows, and reporting observes and never reaches
  back (`docs/arch/diagnostics.md`). They read; they never write state.

## The artifact shelf is a READ over existing evidence, never a new write surface

`model/artifacts.ts` derives semantic artifacts (uat-report, review, ship-summary) from `stages`, `gate_runs`, `review_findings`, `uat_findings`, `process_runs`, `ship_runs`, and `prs` — the same evidence rows the inside views already render. Origin `core` is resolved from the immutable identity snapshot `process_runs.provider` (captured at launch, never rewritten), falling back to `tickets.session_provider` then `tickets.agent_provider` — never invented. The detail payload rides the same snapshot (no async `artifact.get` round trip); the only failure mode is a missing resource file, reported by the host opener exactly like `openStageLog` (extension.ts:4599). Staleness is whether impl/fix re-ran after the artifact — a stale artifact still renders its content, it just warns it no longer validates current code. `DashboardState.artifacts` is the single host-side derivation (state.ts); the webview's index/detail are local renders. `artifact-open-resource` carries artifact id + resource index — never a path — and the host re-derives before opening.

## The per-ticket base-branch columns

`tickets.base_refs` (schema v48) is a JSON map of manifest repository NAME → plain branch name, the PRE-spin override; after spin, `worktrees.base_ref` is the authority (`docs/arch/worktrees-and-servers.md`'s base-branch section). `worktrees.needs_force_push` (schema v49) is armed only when `changeBaseRef`'s rebase actually rewrote the branch, and is read and cleared by the same statement (`takeForcePushLease`) so one rewrite arms exactly one force push.

## The per-ticket env overrides column

`tickets.env_overrides` (schema v55) is a JSON map of scope → `{KEY: value}`, where a scope is a manifest repository NAME or `*` (every service). It is merged into a hot service's spawn env between the repository's `.env` and karst's resolved vars — see `docs/arch/worktrees-and-servers.md`'s spawn-env section for the layering and why the resolved vars still win. NULL is the canonical "nothing overridden"; writes are per SCOPE (`setServiceEnvOverrides`), scoped like `setDisabledGates` so an editor that loaded before another service was touched cannot revert it.

## One worktrees row per (ticket, path)

`worktrees` carries a UNIQUE index on `(ticket_id, path)` (schema v61). The pair is the checkout's identity: `createWorktree` adopts the existing row when git still lists the checkout, but when the checkout was pruned from git while the row survived it took the create path and INSERTed a second row for the same path — once per re-spin, which rendered as duplicated dashboard worktree cards. Both inserts are now UPSERTs (the adopt path DO NOTHING; the freshly cut checkout refreshes `branch`/`base_ref`, keeping the original `created_at`), and the v61 migration collapses pre-existing duplicates, earliest row wins.

## v64: sub-task autostart and parent–child mailbox schema

**Sub-task autostart columns** (tickets table):
- `autostart_pending` (INTEGER NOT NULL DEFAULT 0, indexed `idx_tickets_autostart`): tri-state (0 none, 1 queued, 2 starting); semantics in `docs/arch/stages-and-gates.md`, "Sub-task autostart".
- `autostart_claimed_at` (TEXT): set by `claimAutostart` (→ 2), cleared on release, scope pass, detach and archive; a 2 at scope whose claim is NULL or older than 10 min is re-queued to 1.

**Parent–child mailbox** (`ticket_messages`, new in v64, `TICKET_MESSAGES_DDL` in `store/ticketMessagesRepair.ts`):
- `id`: INTEGER PRIMARY KEY AUTOINCREMENT — ids are never reused, which the delivery sweep's in-memory watermarks and wake baseline depend on.
- `project_id`: the sender's/child's project (FK, ON DELETE CASCADE); NULL when the ticket is unscoped.
- `from_ticket_id`: the sending ticket; NULL = host event.
- `to_ticket_id`: the recipient — the sender's direct parent OR a direct child for a message; always the child's parent for an event.
- `kind`: `'message'` (agent-posted) or `'event'` (host-written), CHECK-constrained.
- `body`: prose for BOTH kinds, trimmed, ≤ 4096 (`MAX_MESSAGE_BODY`); events read e.g. `<key> landed (done)`, `<key> blocked at <stage>: <reason>`, `<key> autostart failed: …`. Untrusted for messages.
- `created_at`, `read_at` (NULL = unread; set only by `karst inbox`'s `markRead`).
- `woke_at`: the wake-claim timestamp — set once, atomically, by `claimWake` when a sweep takes a terminal wake decision (wake or skip) on an event row; NULL = undecided.

Indexes: `idx_ticket_messages_inbox (to_ticket_id, read_at)` for inbox reads; `idx_ticket_messages_wake (project_id, kind, woke_at, id)` for the delivery sweep.

**Repair** (`repairTicketMessages`): early (unreleased) v64 DBs carry `ticket_messages` without `woke_at` or AUTOINCREMENT. `migrate` runs the repair at the end of the v64 step and, on a DB already at 64, whenever `ticketMessagesNeedsRepair` is true (in an immediate transaction with foreign keys off): rename, recreate, copy every row with its id (`woke_at` kept if it existed, else NULL), drop the old table, ensure the indexes. A no-op when the table is absent or current. Nothing is derived from stage evidence.

**Cross-window risk (L1).** Bumping to v64 makes the graph verbs of every OLDER build refuse this DB: `openGraphWritableStore` calls `assertExactSchema` (`cli/assertMigrated.ts`, `user_version !== SCHEMA_VERSION` throws), so `karst graph submit` and `karst node complete|block|replan` from a v63 window sharing the same global-storage registry fail with "requires exactly v63" until that window's extension is updated. The non-graph verbs use `assertMigratedSchema`, which only refuses an OLDER registry.

## New schema column checklist

New schema column checklist: `schema.sql` (fresh DBs) + a guarded ALTER in `migrations.ts` + bump `SCHEMA_VERSION` + update db.test.ts's version/table-count assertions. Migrations never backfill data they can't derive — defer that to the host (see project adoption). Guards read the CURRENT columns (`tableColumns`), so a fresh DB skips the step and a re-open is a no-op — that is what keeps v10's `service`→`repo` RENAME (the one non-additive step) idempotent.