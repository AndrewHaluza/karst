# Archive Compact: Worktree Archiving & Branch Pruning

## Problem

Karst creates a git worktree per ticket. 162 worktree directories consume **15 GB** on disk. The current archive mechanism (`archive.ts`) removes the directory but keeps the branch forever — 252 stale branches accumulate with no sweep. There is no automatic compaction, no branch pruning, and `worktree_archives` is not cleaned up when a ticket is deleted (orphan rows + orphan refs).

**Goal:** A proper archive lifecycle that reclaims disk space, prunes branches, and restores worktrees to full working state.

## Current State

### Archive flow (`archiveWorktree`)
1. `git add -A` → `write-tree` → `commit-tree` (captures uncommitted delta as `refs/karst/archive/<slug>`)
2. `removeWorktree` — stops servers, deletes dir, deletes `worktrees` row, releases ports
3. `recordArchive` — inserts into `worktree_archives` with `method: 'git-ref'`

### Restore flow (`restoreWorktree`)
1. Look up `worktree_archives` by `(ticket_id, path)`
2. Verify branch still exists — **skip loudly if gone** (delta preserved at ref)
3. `createWorktree` on stored branch at original path
4. If archive ref: `cherry-pick -n` → `reset -q HEAD` → `update-ref -d`
5. `clearArchive` — deletes the row

### What's broken
- **No branch pruning:** branches survive archive indefinitely; 252 stale
- **No auto-sweep:** `archiveInactiveWorktrees` is a manual command only; the auto-archive sweep only stamps `archived_at` on tickets, never touches worktree dirs
- **No orphan cleanup:** `worktree_archives` is NOT in `TICKET_CHILD_TABLES` — `deleteTicket` leaves orphan rows + orphan `refs/karst/archive/*` refs
- **No compaction:** method is hardcoded `'git-ref'`; no branch deletion step

## Design

### Archive lifecycle (two tiers)

```
active ──archive──▸ git-ref ──compact──▸ git-ref-compact
                                            │
                                        restore
                                            │
                                            ▼
active ◂──────────────────────────────────────┘
```

| Tier | Dir | Branch | Archive ref | Restore cost |
|---|---|---|---|---|
| `git-ref` | deleted | **kept** | may exist | fast (branch exists) |
| `git-ref-compact` | deleted | **deleted** | always exists | moderate (recreate branch) |

### Tier 1: `git-ref` (existing — no change)

The current archive. Removes dir, keeps branch. Fast restore because the branch already exists.

### Tier 2: `git-ref-compact` (new)

**When:** Automatically, after a configurable delay (default: 7 days since `archived_at`), or on-demand via a new `karst.compactArchives` command.

**Compact operation:**

```
compact(store, repoPath, archiveRow):
  1. If archiveRow.archiveRef == '' (clean tree, no uncommitted delta):
       Create a snapshot ref:
         commit-tree HEAD^{tree} -p HEAD -m "karst-archive:<slug>"
       → refs/karst/archive/<slug>
       This makes the archive ref always exist with the branch tip as parent.

  2. Delete the branch:
       git branch -D <branch>

  3. Update method in worktree_archives:
       UPDATE worktree_archives SET method = 'git-ref-compact' WHERE id = ?

  4. Report reclaimed branch ref (trivial) + signal that dir is reclaimable.
```

**Invariant after compact:** `refs/karst/archive/<slug>` ALWAYS exists and its parent (`<ref>^`) is the branch tip commit. This is what makes restore possible without the branch.

### Restore from compact

```
restoreFromCompact(store, repoPath, archiveRow):
  1. Verify refs/karst/archive/<slug> exists — skip loudly if gone (data loss).

  2. Determine branch tip:
       git rev-parse <archiveRef>^

  3. Recreate the branch at the tip:
       git branch <branch> <archiveRef>^

  4. Recreate the worktree (same as git-ref restore):
       createWorktree(store, { ticketId, repoPath, slug, branch, baseRef })

  5. If there's an uncommitted delta (tree differs from parent):
       git cherry-pick -n <archiveRef>
       git reset -q HEAD

  6. Delete the archive ref:
       git update-ref -d <archiveRef>

  7. clearArchive(store, row.id)
```

### Orphan branch sweep (new)

**When:** On activation (like `reconcileOnStart`) and after bulk archive/compact.

```
sweepOrphanRefs(runner, repoPath, store):
  1. List all refs/heads/karst/* branches
  2. For each branch:
       Check worktrees table (has row with this branch?) OR
       Check worktree_archives table (has row with this branch?)
       → If neither: git branch -D <branch>  (orphan)

  3. List all refs/karst/archive/* refs
  4. For each ref:
       Check worktree_archives table (has row with this archive_ref?)
       → If neither: git update-ref -d <ref>  (orphan)

  5. Report counts: { prunedBranches, prunedArchiveRefs }
```

### Ticket delete cleanup (fix existing gap)

Add `worktree_archives` to `TICKET_CHILD_TABLES` — no code change needed, just the table name. But the git refs also need cleanup:

```
cleanupTicketArchives(runner, store, ticketId):
  1. List all archive rows for this ticket
  2. For each row:
       If row.archiveRef: git update-ref -d <row.archiveRef>
  3. clearArchive for all rows (handled by TICKET_CHILD_TABLES)
```

### Schema changes

No new columns needed. The existing `method` field carries the tier. `reclaimed_bytes` is still reserved for future use (could report branch ref size, but trivial).

### New CLI verb

`compact` — compact archived worktrees:

```
karst compact --db <path> --manifest <path>
```

- Finds all `worktree_archives` rows with `method = 'git-ref'` where `archived_at < now - delay`
- Runs compact on each
- Then runs orphan sweep
- Prints summary

### New commands (extension)

- `karst.compactArchives` — manual trigger, same as CLI
- Automatically triggered on activation after initial delay (like `autoArchiveDoneTickets`)

## Restore correctness proof

**Claim:** For any archived worktree, compact preserves the ability to restore to exact pre-archive state.

**Proof by construction:**

1. **Branch tip recovery:** After compact, `refs/karst/archive/<slug>^` IS the branch tip commit. This is guaranteed because:
   - For dirty trees: the archive commit was created with `commit-tree <tree> -p HEAD`, so parent = HEAD = branch tip
   - For clean trees: the snapshot ref is created with `commit-tree HEAD^{tree} -p HEAD`, same property
   - The ref is never modified between creation and restore

2. **Uncommitted delta recovery:** The archive ref's tree captures the working tree state at archive time. `cherry-pick -n` applies the diff (parent→tree = delta) exactly.

3. **Branch recreation:** `git branch <name> <commit>` is a pure pointer operation. The branch name is stored in `worktree_archives.branch` and never changes.

4. **Worktree recreation:** `createWorktree` on the recreated branch at the stored path reproduces the original checkout.

**Therefore:** compact → restore is equivalent to the current archive → restore, with the branch recreation step added.

## Implementation tasks

### Phase 1: Core compact + orphan sweep
- [ ] `compactWorktree(runner, store, row)` in `archive.ts`
- [ ] `sweepOrphanRefs(runner, repoPath, store)` in a new `archiveSweep.ts`
- [ ] `karst.compactArchives` command in `extension.ts`
- [ ] Unit tests for compact (clean tree + dirty tree + missing ref)
- [ ] Unit tests for orphan sweep (orphan branch + orphan ref + no-ops)

### Phase 2: Auto-sweep + ticket cleanup
- [ ] Activation sweep: `sweepOrphanRefs` on `reconcileOnStart`
- [ ] Auto-compact: sweep `method='git-ref'` rows older than N days on activation
- [ ] Add `worktree_archives` to `TICKET_CHILD_TABLES` (migration v45)
- [ ] `cleanupTicketArchives` before row deletion (delete git refs)
- [ ] CLI verb `karst compact`

### Phase 3: Bulk compact command
- [ ] `compactInactiveArchives(runner, store, allocator, scope)` in `archiveBulk.ts`
- [ ] Expose as `karst.compactInactiveArchives` command
- [ ] Wire into Settings → General as a button (like archive)
