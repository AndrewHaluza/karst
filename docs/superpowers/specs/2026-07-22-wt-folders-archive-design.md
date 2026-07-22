# WT Folders Archive — Design

**Ticket:** 869e620qz — [FEAT] WT folders archive
**Date:** 2026-07-22

## Problem

Worktree (WT) folders live at `<repo>/.karst/worktrees/<slug>` — one full git
linked-worktree checkout per ticket. They accumulate in a single unmanaged pile
(43 at time of writing) with no reaping mechanism:

- `archiveTicket` only soft-deletes the ticket DB row (`archived_at`) — it never
  touches disk.
- `deleteTicket` likewise leaves the folder.
- The only code that removes a folder is `removeWorktree`, called solely on
  spin-teardown, and it **hard-deletes** — dropping any uncommitted work.

So there is no path that reclaims folder space while keeping the worktree
restorable.

## Key insight

A karst worktree is a git *linked* worktree on branch `karst/<slug>`, and that
branch lives in the parent repo's object store. **Committed work is already
durable** — it survives folder deletion because the branch does. The only state
that lives *solely* in the folder is the uncommitted delta: tracked
modifications, staged changes, untracked files, and deletions (plus build
artifacts / any local `node_modules`, which are disposable).

Therefore "store git changes only" is not just viable — it is the minimal
correct capture. We need to persist only the uncommitted delta; git already
persists everything else.

## Chosen approach: git-ref WIP snapshot

Capture the uncommitted state as a throwaway WIP commit stored under a dedicated
ref, then remove the folder. The branch is never mutated.

Rejected alternatives:

- **Bundle file** (`git bundle` the WIP commit to `.karst/archive/<slug>.bundle`)
  — duplicates objects into a file and needs re-import; no upside since the
  parent repo already persists refs durably.
- **Tarball the working tree** — larger, loses the git relationship, restore is
  extract-over-checkout with drift risk. Kept only as a narrow fallback for
  *orphan* folders that have no git worktree registration.

Trade-offs (chosen): storage = git delta objects only (KB–MB, shared/packed by
the parent repo); fidelity = git plumbing handles binaries, file modes,
deletions, untracked exactly; reliability = no text-patch fuzz and the branch is
never touched, so committed work can never be lost.

## Trigger model

Archiving a WT folder is **coupled to ticket archive** (decided):

- `karst.archiveTicket` → soft-delete row **and** archive the WT folder.
- `karst.unarchiveTicket` → clear row **and** restore the WT folder.
- Plus a bulk `karst.archiveInactiveWorktrees` command to clear the existing
  backlog in one shot.

Restore fidelity (decided): all uncommitted state returns as **working-tree
edits** — the staged/unstaged split collapses (everything comes back unstaged).
Git-native, robust for binaries, sufficient mid-flight.

## Module boundaries

Host-agnostic: all logic takes an injected async `GitRunner` (`src/integrations/git.ts`).
No `vscode` import — everything runs under vitest with a real git tmp repo.

- **`src/runtime/archive.ts`** — `archiveWorktree(git, store, allocator, record)`,
  `restoreWorktree(git, store, record)`. Core capture/restore logic.
- **`src/store/worktreeArchives.ts`** — CRUD for the new table: `recordArchive`,
  `getArchive`, `clearArchive`, `listArchives`. Immutable row objects.
- **`src/runtime/archiveBulk.ts`** —
  `archiveInactiveWorktrees(git, store, allocator, { isAlive })`. Selection,
  dedup, sequential execution, summary.
- **`src/extension.ts`** — thin wiring: extend `archiveTicket` / `unarchiveTicket`
  commands, register `karst.archiveInactiveWorktrees` (+ `package.json`
  contribution).

### Why async GitRunner (not the existing `spawnSync` in `worktree.ts`)

Bulk archive iterates up to 43 folders. The extension-host event-loop invariant
(CLAUDE.md) forbids blocking it; a sync spawn per folder would freeze every other
session's hook channel and the whole UI. Archive/restore therefore use the async
`GitRunner` from `git.ts` and run the bulk loop with `await`.

## Data model

New table, `SCHEMA_VERSION` 10 → 11:

```sql
CREATE TABLE IF NOT EXISTS worktree_archives (
  id              INTEGER PRIMARY KEY,
  ticket_id       INTEGER NOT NULL,     -- -> tickets.id
  repo            TEXT NOT NULL,        -- repository name
  path            TEXT NOT NULL,        -- original worktree path (restore target)
  branch          TEXT NOT NULL,        -- karst/<slug>, survives archive
  base_ref        TEXT,                 -- branch point (carried from worktrees row)
  archive_ref     TEXT NOT NULL,        -- refs/karst/archive/<slug>; '' = no uncommitted delta
  method          TEXT NOT NULL,        -- 'git-ref' (only value in v1; column reserved for future 'tarball')
  reclaimed_bytes INTEGER,              -- reserved/nullable; NOT populated in v1 (a byte walk would block the host event loop)
  archived_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Migration follows the CLAUDE.md schema-column checklist:
- guarded `CREATE TABLE IF NOT EXISTS` in `migrations.ts` (fresh DBs get it from
  `schema.sql`; the guarded step is a no-op on re-open),
- bump `SCHEMA_VERSION` to 11,
- update `db.test.ts` version/table-count assertions (9 hardcoded `user_version`
  literals).

The `worktrees` row is **deleted** on archive (the folder and git worktree no
longer exist — mirrors `removeWorktree`) and re-inserted on restore via
`createWorktree`. An archived ticket legitimately shows "no worktree" until
restored.

## Archive flow — `archiveWorktree`

1. **Guard.** Folder exists and is a registered git worktree
   (`worktreeRegisteredAt`). If not → orphan: **skip + report** (never delete a
   folder git cannot restore; tarball fallback deferred past v1).
2. **Capture uncommitted into a ref.** The worktree is deleted immediately after,
   so staging into its real index is harmless — no throwaway index needed (and the
   injected async `GitRunner` exposes no env/stdin, so `GIT_INDEX_FILE` and pipes
   are out anyway). All argv-only:
   - `git add -A` (stages tracked mods, deletions, untracked; `.gitignore` excludes
     `node_modules`/`dist` automatically)
   - `git write-tree` → `tree`
   - `git rev-parse HEAD^{tree}` → HEAD tree; if equal → no uncommitted work →
     `archive_ref = ''`, skip the commit
   - else `git -c user.name=karst -c user.email=karst@local commit-tree <tree>
     -p HEAD -m "karst-archive:<slug>"` → `commit` (explicit identity so capture
     never fails on a repo with no configured user);
     `git update-ref refs/karst/archive/<slug> <commit>`
   - Parent is the branch tip, so the ref's diff against the branch is exactly
     the uncommitted delta. The branch itself is never moved.
4. **Remove** via existing `removeWorktree(store, record, allocator)`:
   `git worktree remove --force` + `rmSync` folder + delete `worktrees` row +
   release ports.
5. **Record** — `recordArchive(...)` inserts the `worktree_archives` row.

All git invocations run through the injected async `GitRunner`. The capture runs
in the worktree cwd and MUST complete before removal.

## Restore flow — `restoreWorktree`

1. **Recreate** — `createWorktree(...)` re-adds the git worktree from the
   surviving branch at the original path (existing "branch exists → attach"
   branch of that function) and re-inserts the `worktrees` row.
2. **Re-apply delta** — if `archive_ref` is non-empty (argv-only, no pipe):
   `git cherry-pick -n <archive_ref>` applies the archive commit's parent→commit
   diff (== the uncommitted delta, since its parent is the branch tip) into the
   working tree + index, then `git reset -q HEAD` unstages it (and clears
   `CHERRY_PICK_HEAD`). Result: tracked mods reappear, untracked files return as
   untracked, deletions are re-removed — everything **unstaged** (matches the
   fidelity decision).
3. **Cleanup** — `git update-ref -d refs/karst/archive/<slug>` and `clearArchive`.
4. **Failure handling** — if the branch was deleted, or the path is occupied,
   restore fails **loudly** and the archive ref is **kept** so the delta remains
   recoverable. Never a silent loss.

## Bulk backlog — `archiveInactiveWorktrees`

Clears the existing pile and covers newly-created worktrees uniformly.

- **Candidate = inactive:** the ticket is archived (`archived_at IS NOT NULL`) OR
  its stage is terminal (`stage_current = 'done'` — ship→done, per `STAGE_GRAPH`).
- **Exclude:** any worktree whose ticket `agent_state = 'running'` — the sole
  liveness signal (`setAgentState`); never archive work in flight.
- **Dedup by `path`** — repository entries that share a `repoPath` resolve to one
  worktree (per CLAUDE.md); archive each folder once.
- Sequential; one item's failure does not abort the rest.
- Returns `{ archived, skipped, failed }` (counts).
- Command surface: confirm modal ("Archive N inactive worktrees?") → run → toast
  the summary counts.

## Edge cases

- **No uncommitted changes** → `archive_ref = ''`; folder removed; restore =
  recreate worktree only.
- **Branch deleted after archive** → restore errors loud; the uncommitted delta
  is still in the ref and recoverable.
- **Orphan folder** (folder present but no git worktree registration) → **skip +
  report**; never delete a folder git cannot restore. All karst-created worktrees
  in the pile are git-registered, so the git-ref path covers the backlog; tarball
  fallback is deferred past v1.
- **Idempotent** — archiving a ticket whose folder is already gone is a no-op (no
  `worktrees` row, no folder).
- **Cross-window** — `refs/karst/archive/<slug>` is unique per slug; the global DB
  is the single source of truth. Safe across IDE windows.

## Testing (TDD, real git tmp repo)

- **`archive.test.ts`** — capture includes tracked mods + untracked + deletions;
  folder removed; branch survives; restore roundtrips all of it as working-tree
  edits; binary-file roundtrip; no-uncommitted case (`archive_ref = ''`).
- **`worktreeArchives.test.ts`** — store CRUD + row immutability.
- **`archiveBulk.test.ts`** — inactive-only selection; skips live session; dedups
  by path; per-item failure isolation; summary counts.
- **`db.test.ts`** — v11 migration adds the table; table count + version literals
  updated.

## Acceptance-criteria mapping

1. *WT archived and removed from active pile* → archive removes folder + git
   worktree + `worktrees` row.
2. *Archived WT fully restored* → surviving branch + replayed ref delta.
3. *Space-efficient vs full copy* → only git delta objects persist (~KB), shared
   and packed by the parent repo, vs a full checkout + build artifacts.
4. *Reliable, no committed/uncommitted loss* → branch never mutated;
   capture-before-remove ordering; failure keeps the ref.
5. *Documented rationale/trade-offs* → this document.
6. *Handles existing backlog* → bulk `archiveInactiveWorktrees` plus the
   coupled per-ticket path.
