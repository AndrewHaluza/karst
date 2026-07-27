# Continue Work on a Ticket (Follow-up Tickets)

Ticket: 869e8h3bj

## Problem

Once a ticket reaches `done` (implemented, reviewed, shipped, PR merged), there's
currently no convenient way to file follow-up fixes or improvements discovered during
manual testing. The only option today is creating a brand-new ticket from scratch,
which starts a blank agent session with no knowledge of what was just built — burning
tokens re-deriving context (which repos, which approach, what the original change
actually did) that karst already has on hand.

## Goals

- A one-click way to spin up a follow-up ticket from a completed one.
- The follow-up's agent session starts with real context about the parent ticket's
  work (what was built, where, the PR), not a blank slate.
- The relationship is visually obvious in the UI — this is a sub-task of something,
  not an unrelated new ticket.
- Minimal new surface area: reuse existing ticket creation, worktree, and context-
  building machinery rather than inventing parallel systems.

## Non-goals

- Reopening/resuming the *same* ticket's agent session or worktree. The parent's
  branch is already merged; continuing on it doesn't make sense once a fresh base
  has moved on.
- Persisting or replaying the parent's actual conversation transcript. Karst doesn't
  store session transcripts today (that's delegated entirely to the agent CLI's own
  session store, keyed by an opaque `session_id` scoped to the original worktree
  `cwd`) and building that is out of scope here.
- Writing the relationship back to ClickUp (or any external tracker) as a real
  subtask. The follow-up is a karst-native ticket; the user can link it manually in
  the external tracker if they want that.
- A sidebar tree/nesting UI. The sidebar stays a flat list with a small annotation.

## Current state (research findings)

- Stage graph terminates at `done` (`src/workflow/graph.ts`); reaching `done` only
  flips `tickets.stage_current` — no archiving, no cleanup happens automatically.
- Archiving (`tickets.archived_at`) is a fully separate, manual, orthogonal action
  (`karst.archiveTicket`) that also tears down the ticket's worktree. A `done` ticket
  can sit active (unarchived, worktree intact) indefinitely.
- `buildTicketContext`/`renderTicketContext` (`src/context/ticketContext.ts`) already
  assembles a per-ticket markdown context block (description, brief, approach, agent,
  repos, worktrees, servers, PRs) that seeds every new agent session
  (`src/agent/seed.ts`). This is the natural extension point for parent context.
- No parent/child or subtask concept exists anywhere in karst's schema, types, or
  store layer today. ClickUp's own relation kinds (`parent`/`child`/`related`/etc.,
  `src/integrations/clickup.ts`) are read-once into brief markdown text only — never
  persisted as a queryable karst-side graph.
- Worktrees persist past `done` and are only removed by explicit archive. Worktree
  creation (`src/runtime/worktree.ts`) already has adopt/reuse-on-retry logic, but
  always keyed by the *same* ticket's slug — there's no existing path for one ticket
  to target another ticket's worktree/branch, and there's no reason to want that here
  since the parent's work already landed on the configured base branch.
- `gate_runs`/`phase_marks` are pass/fail-plus-timing evidence tables with no
  narrative content; per-attempt stdout/stderr logs on disk get overwritten by the
  next retry. Not usable as a "here's what we learned" source — the brief/PR is the
  right source for that instead.
- No `duplicateTicket`/`continueTicket`/`linkTicket` command or UI affordance exists
  anywhere in the extension today.

## Design

### Data model

Add `parent_ticket_id` (nullable, `TEXT REFERENCES tickets(id)`, indexed) to
`tickets`. Bump `SCHEMA_VERSION`, add the guarded `ALTER TABLE` in `migrations.ts`
following the existing `tableColumns`-guard idempotency pattern, add it to
`schema.sql` for fresh DBs, and update the hardcoded version/table-count assertions
in `db.test.ts`. `Ticket`/`TicketWithStages` (`src/store/tickets.ts`) gain an optional
`parentTicketId` field.

### Creating a follow-up

New command `karst.createFollowUpTicket(sourceTicketId)`:

1. Load the source ticket, scoped by `projectId` (same scoping discipline as every
   other ticket query).
2. Guard: reject unless `stage_current === 'done'`. The UI only renders the trigger
   in this state, but the command re-validates in case of a stale view.
3. Synthesize the child ticket:
   - `key`: `<parentKey>-fu<n>`, where `n` is the next unused suffix among existing
     children of this parent (handles multiple follow-ups off the same parent).
   - `title`: `Follow-up: <parent title>`.
   - `description`: empty — the user fills in the actual follow-up ask. Sharing
     context is not the same as guessing the new task.
   - `selectedRepos`, `approach`, `agent`/`model`: copied verbatim from the parent.
   - `source`: `'karst'` (no external ticket is created).
   - `parentTicketId`: the parent's `id`.
4. Call the existing `createTicket` (extended with the optional `parentTicketId`
   param) — no onboarding webview, ticket is immediately ready to spin.

No new worktree/branch logic is needed. A follow-up ticket is, mechanically, an
ordinary new ticket: `spinTicket` creates a fresh worktree off the repo's configured
base branch exactly as it does for any other ticket, and the parent's merged work is
already present in that base. The only thing that makes it a "follow-up" is the
`parentTicketId` link and the pre-filled repo/approach/agent selection.

### Context sharing

`buildTicketContext` gains: when `ticket.parentTicketId` is set, look up the parent
ticket and render a `## Continuing from <parentKey>: <parent title>` section
containing the parent's brief markdown and its PR URL(s) (from the `prs` table). No
diff or commit-log text is embedded — that would bloat every session's prompt whether
or not the agent needs it. If the agent needs the actual diff, it can pull it itself
via `gh pr diff <url>`. If the parent ticket has since been deleted (not just
archived — archived tickets keep their row), the section renders
`(parent ticket no longer available)` instead of failing context construction.

### UI

- **Detail panel**: a "Continue work →" button, shown whenever the viewed ticket's
  `stage_current === 'done'` (this includes archived tickets, since archiving only
  sets `archived_at` and never changes `stage_current`). Wired to the new command.
- **Sidebar**: `TicketNode` gains an optional `parentKey`/`parentTitle`, rendered as
  a small "↳ follow-up of `<parentKey>`" annotation under the ticket's label. The
  sidebar stays a flat list — no tree restructuring.

### Error handling

- Source ticket missing or in the wrong project → command aborts with a VS Code error
  message, no partial ticket created.
- Source ticket not `done` → button is hidden in the normal path; the command itself
  still re-checks and rejects with a clear message (defends against a stale sidebar
  cache triggering the command directly).
- Key collision on `-fu<n>` → computed by counting existing children before insert;
  `createTicket`'s existing idempotent-by-key behavior is the backstop if two
  follow-ups race.
- Parent later hard-deleted (`deleteTicket`) → `buildTicketContext` degrades
  gracefully per above rather than throwing.

### Testing

- `store/tickets.test.ts`: `createTicket` persists/round-trips `parentTicketId`.
- `db.test.ts`: schema migration guard test, updated version/table-count literals.
- `context/ticketContext.test.ts`: renders the parent section when set, omits it when
  absent, degrades gracefully when the parent no longer exists.
- Command test for `createFollowUpTicket`: copies repos/approach/agent from parent,
  generates the next free `-fuN` key, rejects a non-`done` source ticket.
- `ui/sidebar/items.test.ts`: label includes the follow-up annotation when
  `parentTicketId` is set.

## Alternatives considered

1. **Reopen the same ticket** instead of creating a child (reset `stage_current` back
   to `impl`/`fix`, reuse the same worktree/branch). Rejected: the branch is already
   merged and closed out; reopening it re-opens a closed PR and loses the `done`
   history. A new linked ticket keeps history intact and matches the "clearly a
   sub-task" requirement.
2. **Agent-generated narrative handoff** (spawn a headless agent run at parent
   completion to write a "what was built, key decisions, gotchas" summary into a new
   column) instead of the structured brief/PR summary. Rejected for now: adds a new
   agent-invocation step (cost/latency) that runs even for tickets that never get a
   follow-up. The structured summary is free (no extra agent call) and reuses the
   existing `renderTicketContext` pattern; a narrative writeup can be layered in later
   as a lazy, on-demand enhancement if the structured summary proves insufficient in
   practice.
3. **Write the relationship back to ClickUp** as a real subtask. Rejected: karst's
   ClickUp integration is read-only today; adding a write path is materially more
   scope than this feature needs, and the karst-local link is sufficient for the
   stated goal (agent context continuity), independent of external tracker state.
