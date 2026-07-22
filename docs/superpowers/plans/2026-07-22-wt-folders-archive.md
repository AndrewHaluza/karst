# WT Folders Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclaim disk from the pile of worktree folders by archiving each into a git ref that holds only its uncommitted delta, fully restorable from the surviving branch.

**Architecture:** A worktree is a git linked-worktree on branch `karst/<slug>`; committed work already lives on that branch in the parent repo. Archiving captures only the *uncommitted* delta as a WIP commit under `refs/karst/archive/<slug>`, then removes the folder + git worktree. Restore recreates the worktree from the branch and replays the delta as unstaged edits. A new `worktree_archives` table tracks archives; a bulk command clears the existing backlog.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), better-sqlite3 via `Store`, injected async `GitRunner` (`src/integrations/git.ts`), vitest with real git tmp repos.

## Global Constraints

- ESM: all local imports need a `.js` suffix; `moduleResolution: Bundler`.
- `noUncheckedIndexedAccess` on — array access needs `!` or a guard.
- Immutability: never mutate a row object in place; return new objects.
- Extension-host event loop must never block: all git in archive/restore/bulk goes through the **async** `GitRunner`, never `spawnSync`.
- Schema-column checklist (CLAUDE.md): new table → `schema.sql` + guarded step in `migrations.ts` + bump `SCHEMA_VERSION` + update `db.test.ts` (version literals + `EXPECTED_TABLES`).
- Single-writer discipline for DB mutations; store helpers own their SQL.
- Files stay focused (<400 lines typical).
- Commit format: Conventional Commits (`feat:`, `test:`, `docs:`). Attribution disabled globally.
- Run a single test file with: `npx vitest run <path>`. Full suite: `npm test`. Types: `npm run typecheck`.

---

### Task 1: Schema + v11 migration for `worktree_archives`

**Files:**
- Modify: `src/store/schema.sql` (add table after the `worktrees` table, ~line 105)
- Modify: `src/store/migrations.ts` (bump `SCHEMA_VERSION`; add `current < 11` step)
- Test: `src/store/db.test.ts` (add table to `EXPECTED_TABLES`, bump version literals, add a v10→v11 migration test)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: table `worktree_archives(id, ticket_id, repo, path, branch, base_ref, archive_ref, method, reclaimed_bytes, archived_at)`; `SCHEMA_VERSION = 11`.

- [ ] **Step 1: Add the table to `schema.sql`**

Insert immediately after the `worktrees` table `CREATE TABLE` block (after line 105):

```sql
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
```

- [ ] **Step 2: Add the failing db.test assertions**

In `src/store/db.test.ts`, add `'worktree_archives'` to the `EXPECTED_TABLES` array (after `'merge_checks'`). Change the test title/count `'creates all 11 registry tables'` → `'creates all 12 registry tables'`. Replace every `.toBe(10)` version assertion with `.toBe(11)`. Then add this new test after the v9→v10 migration test (near line 334):

```typescript
it('migrates a v10 DB to v11, adding worktree_archives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'karst.db');

  const legacy = openStore(dbPath);
  legacy.db.pragma('user_version = 10');
  legacy.close();

  const migrated = openStore(dbPath);
  cleanups.push(() => migrated.close());
  expect(tableNames(migrated)).toContain('worktree_archives');
  expect(migrated.db.pragma('user_version', { simple: true })).toBe(11);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/store/db.test.ts`
Expected: FAIL — `worktree_archives` missing and version is still 10.

- [ ] **Step 4: Bump version + add the migration step**

In `src/store/migrations.ts` change:

```typescript
export const SCHEMA_VERSION = 10;
```
to
```typescript
export const SCHEMA_VERSION = 11;
```

Then, immediately before the final `db.pragma(\`user_version = ${SCHEMA_VERSION}\`);` line, add:

```typescript
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/store/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/schema.sql src/store/migrations.ts src/store/db.test.ts
git commit -m "feat(store): add worktree_archives table (schema v11)"
```

---

### Task 2: Store helpers for `worktree_archives`

**Files:**
- Create: `src/store/worktreeArchives.ts`
- Test: `src/store/worktreeArchives.test.ts`

**Interfaces:**
- Consumes: `worktree_archives` table (Task 1); `Store` from `./db.js`.
- Produces:
  - `interface ArchiveRow { id: number; ticketId: number; repo: string; path: string; branch: string; baseRef: string | null; archiveRef: string; method: string; archivedAt: string }`
  - `interface NewArchive { ticketId: number; repo: string; path: string; branch: string; baseRef: string | null; archiveRef: string; method: string }`
  - `interface ArchivableWorktree { ticketId: number; repoPath: string; path: string; branch: string; baseRef: string }`
  - `recordArchive(store, a: NewArchive): void`
  - `listArchives(store, ticketId: number): ArchiveRow[]`
  - `getArchiveByPath(store, ticketId: number, path: string): ArchiveRow | null`
  - `clearArchive(store, id: number): void`
  - `listArchivableWorktrees(store): ArchivableWorktree[]`

- [ ] **Step 1: Write the failing test**

Create `src/store/worktreeArchives.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import {
  recordArchive,
  listArchives,
  getArchiveByPath,
  clearArchive,
  listArchivableWorktrees,
} from './worktreeArchives.js';

describe('worktreeArchives store', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  it('records, lists, gets by path, and clears an archive row', () => {
    const t = createTicket(store, { key: 'K-1', title: 'one', source: 'manual' });
    recordArchive(store, {
      ticketId: t.id,
      repo: '/repo',
      path: '/repo/.karst/worktrees/K-1',
      branch: 'karst/K-1',
      baseRef: 'main',
      archiveRef: 'refs/karst/archive/K-1',
      method: 'git-ref',
    });

    const rows = listArchives(store, t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branch).toBe('karst/K-1');
    expect(rows[0]!.archiveRef).toBe('refs/karst/archive/K-1');

    const got = getArchiveByPath(store, t.id, '/repo/.karst/worktrees/K-1');
    expect(got?.baseRef).toBe('main');

    clearArchive(store, rows[0]!.id);
    expect(listArchives(store, t.id)).toHaveLength(0);
    expect(getArchiveByPath(store, t.id, '/repo/.karst/worktrees/K-1')).toBeNull();
  });

  it('listArchivableWorktrees selects archived/done tickets and skips running agents', () => {
    const archived = createTicket(store, { key: 'A', title: 'a', source: 'manual' });
    const done = createTicket(store, { key: 'D', title: 'd', source: 'manual' });
    const active = createTicket(store, { key: 'X', title: 'x', source: 'manual' });
    const running = createTicket(store, { key: 'R', title: 'r', source: 'manual' });

    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(archived.id);
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(done.id);
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now'), agent_state = 'running' WHERE id = ?").run(running.id);

    const mkWt = (id: number, key: string) =>
      store.db
        .prepare(
          `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
           VALUES (?, '/repo', ?, ?, 'main', 'inherited')`,
        )
        .run(id, `/repo/.karst/worktrees/${key}`, `karst/${key}`);
    mkWt(archived.id, 'A');
    mkWt(done.id, 'D');
    mkWt(active.id, 'X');
    mkWt(running.id, 'R');

    const got = listArchivableWorktrees(store).map((w) => w.branch).sort();
    expect(got).toEqual(['karst/A', 'karst/D']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/store/worktreeArchives.test.ts`
Expected: FAIL — `worktreeArchives.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/store/worktreeArchives.ts`:

```typescript
import type { Store } from './db.js';

export interface ArchiveRow {
  id: number;
  ticketId: number;
  repo: string;
  path: string;
  branch: string;
  baseRef: string | null;
  archiveRef: string;
  method: string;
  archivedAt: string;
}

export interface NewArchive {
  ticketId: number;
  repo: string;
  path: string;
  branch: string;
  baseRef: string | null;
  archiveRef: string;
  method: string;
}

export interface ArchivableWorktree {
  ticketId: number;
  repoPath: string;
  path: string;
  branch: string;
  baseRef: string;
}

interface Raw {
  id: number;
  ticket_id: number;
  repo: string;
  path: string;
  branch: string;
  base_ref: string | null;
  archive_ref: string;
  method: string;
  archived_at: string;
}

function toRow(r: Raw): ArchiveRow {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    repo: r.repo,
    path: r.path,
    branch: r.branch,
    baseRef: r.base_ref,
    archiveRef: r.archive_ref,
    method: r.method,
    archivedAt: r.archived_at,
  };
}

/** Insert a worktree-archive row (append-only registry of archived worktrees). */
export function recordArchive(store: Store, a: NewArchive): void {
  store.db
    .prepare(
      `INSERT INTO worktree_archives (ticket_id, repo, path, branch, base_ref, archive_ref, method)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(a.ticketId, a.repo, a.path, a.branch, a.baseRef, a.archiveRef, a.method);
}

/** All archive rows for a ticket, oldest first. */
export function listArchives(store: Store, ticketId: number): ArchiveRow[] {
  return (
    store.db
      .prepare('SELECT * FROM worktree_archives WHERE ticket_id = ? ORDER BY id')
      .all(ticketId) as Raw[]
  ).map(toRow);
}

/** The most recent archive row for a ticket's worktree path, or null. */
export function getArchiveByPath(store: Store, ticketId: number, path: string): ArchiveRow | null {
  const r = store.db
    .prepare('SELECT * FROM worktree_archives WHERE ticket_id = ? AND path = ? ORDER BY id DESC LIMIT 1')
    .get(ticketId, path) as Raw | undefined;
  return r ? toRow(r) : null;
}

/** Delete an archive row by id (called after a successful restore). */
export function clearArchive(store: Store, id: number): void {
  store.db.prepare('DELETE FROM worktree_archives WHERE id = ?').run(id);
}

/**
 * Worktrees eligible for bulk archiving: the ticket is archived or terminal
 * (`stage_current = 'done'`) AND its agent is not currently running. Only rows
 * with a branch are returned — archive/restore both need it.
 */
export function listArchivableWorktrees(store: Store): ArchivableWorktree[] {
  const rows = store.db
    .prepare(
      `SELECT w.ticket_id AS ticketId, w.repo AS repoPath, w.path AS path,
              w.branch AS branch, w.base_ref AS baseRef
       FROM worktrees w
       JOIN tickets t ON t.id = w.ticket_id
       WHERE (t.archived_at IS NOT NULL OR t.stage_current = 'done')
         AND (t.agent_state IS NULL OR t.agent_state != 'running')
       ORDER BY w.path`,
    )
    .all() as {
    ticketId: number;
    repoPath: string;
    path: string;
    branch: string | null;
    baseRef: string | null;
  }[];
  return rows
    .filter((r): r is typeof r & { branch: string } => r.branch != null)
    .map((r) => ({
      ticketId: r.ticketId,
      repoPath: r.repoPath,
      path: r.path,
      branch: r.branch,
      baseRef: r.baseRef ?? r.branch,
    }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/store/worktreeArchives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/worktreeArchives.ts src/store/worktreeArchives.test.ts
git commit -m "feat(store): worktree archive registry helpers"
```

---

### Task 3: Archive + restore core (`archive.ts`)

**Files:**
- Create: `src/runtime/archive.ts`
- Test: `src/runtime/archive.test.ts`

**Interfaces:**
- Consumes: `GitRunner`, `defaultGitRunner` from `../integrations/git.js`; `PortAllocator`, `makePortAllocator` from `../resolver/allocator.js`; `createWorktree`, `removeWorktree`, `canonicalPath`, `WorktreeRecord` from `./worktree.js`; store helpers from `../store/worktreeArchives.js`.
- Produces:
  - `interface ArchiveTarget { ticketId: number; repoPath: string; path: string; branch: string; baseRef: string }`
  - `interface ArchiveResult { outcome: 'archived' | 'skipped'; reason?: string; archiveRef: string }`
  - `interface RestoreResult { outcome: 'restored' | 'skipped'; reason?: string }`
  - `archiveWorktree(runner: GitRunner, store: Store, allocator: PortAllocator, target: ArchiveTarget): Promise<ArchiveResult>`
  - `restoreWorktree(runner: GitRunner, store: Store, target: { ticketId: number; path: string }): Promise<RestoreResult>`

- [ ] **Step 1: Write the failing test**

Create `src/runtime/archive.test.ts`. It builds a real git repo + karst worktree, dirties it, archives, asserts the folder is gone and the branch survives, then restores and asserts every change returns:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { makePortAllocator } from '../resolver/allocator.js';
import { defaultGitRunner } from '../integrations/git.js';
import { createWorktree } from './worktree.js';
import { archiveWorktree, restoreWorktree } from './archive.js';
import { listArchives } from '../store/worktreeArchives.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-arch-'));
  writeFileSync(join(dir, 'index.js'), 'console.log(1);\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'keep.txt'), 'original\n');
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 'test@karst.local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('archive/restore worktree', () => {
  let store: Store;
  let repo: { path: string; cleanup: () => void };

  beforeEach(() => {
    store = openStore(':memory:');
    repo = makeRepo();
  });
  afterEach(() => {
    store.close();
    repo.cleanup();
  });

  function spinWorktree() {
    const rec = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: 'K-9',
      baseRef: 'develop',
    });
    return rec;
  }

  it('archives uncommitted work into a ref, removes the folder, keeps the branch; restore brings everything back', async () => {
    const rec = spinWorktree();
    const alloc = makePortAllocator(store, { start: 4000, end: 4100 });

    // Dirty the worktree: modify tracked, add untracked, delete tracked.
    writeFileSync(join(rec.path, 'index.js'), 'console.log(2);\n'); // modified
    writeFileSync(join(rec.path, 'new.txt'), 'brand new\n'); // untracked
    unlinkSync(join(rec.path, 'keep.txt')); // deletion

    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: rec.path,
      branch: rec.branch,
      baseRef: 'develop',
    });

    expect(res.outcome).toBe('archived');
    expect(res.archiveRef).toBe('refs/karst/archive/K-9');
    expect(existsSync(rec.path)).toBe(false); // folder reclaimed
    // branch survives in the parent repo
    expect(git(repo.path, 'rev-parse', '--verify', '--quiet', 'refs/heads/karst/K-9').trim()).not.toBe('');
    expect(listArchives(store, 1)).toHaveLength(1);

    // Restore
    const rr = await restoreWorktree(defaultGitRunner, store, { ticketId: 1, path: rec.path });
    expect(rr.outcome).toBe('restored');
    expect(existsSync(rec.path)).toBe(true);
    expect(readFileSync(join(rec.path, 'index.js'), 'utf8')).toBe('console.log(2);\n');
    expect(readFileSync(join(rec.path, 'new.txt'), 'utf8')).toBe('brand new\n');
    expect(existsSync(join(rec.path, 'keep.txt'))).toBe(false);
    // changes come back UNSTAGED
    expect(git(rec.path, 'status', '--porcelain')).not.toBe('');
    // ref + row cleared
    expect(git(repo.path, 'rev-parse', '--verify', '--quiet', 'refs/karst/archive/K-9').trim()).toBe('');
    expect(listArchives(store, 1)).toHaveLength(0);
  });

  it('with no uncommitted changes, records an empty ref and restore recreates a clean worktree', async () => {
    const rec = spinWorktree();
    const alloc = makePortAllocator(store, { start: 4000, end: 4100 });

    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: rec.path,
      branch: rec.branch,
      baseRef: 'develop',
    });
    expect(res.outcome).toBe('archived');
    expect(res.archiveRef).toBe('');
    expect(existsSync(rec.path)).toBe(false);

    const rr = await restoreWorktree(defaultGitRunner, store, { ticketId: 1, path: rec.path });
    expect(rr.outcome).toBe('restored');
    expect(existsSync(rec.path)).toBe(true);
    expect(git(rec.path, 'status', '--porcelain')).toBe('');
  });

  it('skips an orphan folder (folder present but not a registered worktree)', async () => {
    const orphan = join(repo.path, 'not-a-worktree');
    mkdtempSync(join(tmpdir(), 'ignore-')); // noop to keep imports honest
    writeFileSync(join(repo.path, 'placeholder'), 'x'); // ensure repo writable
    const alloc = makePortAllocator(store, { start: 4000, end: 4100 });
    // Create a bare folder that is not a git worktree.
    rmSync(orphan, { recursive: true, force: true });
    writeFileSync(join(repo.path, 'orphan-marker'), 'x');
    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: join(repo.path, 'orphan-marker-dir-does-not-exist'),
      branch: 'karst/none',
      baseRef: 'develop',
    });
    expect(res.outcome).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/runtime/archive.test.ts`
Expected: FAIL — `archive.js` not found.

- [ ] **Step 3: Confirm `canonicalPath` is exported from `worktree.ts`**

`canonicalPath` is already `export function canonicalPath(...)` in `src/runtime/worktree.ts`. No change needed. (If a future refactor un-exports it, re-export it — Task 3 depends on it.)

- [ ] **Step 4: Write the implementation**

Create `src/runtime/archive.ts`:

```typescript
import { existsSync } from 'node:fs';
import type { Store } from '../store/db.js';
import type { GitRunner } from '../integrations/git.js';
import type { PortAllocator } from '../resolver/allocator.js';
import { createWorktree, removeWorktree, canonicalPath, type WorktreeRecord } from './worktree.js';
import {
  recordArchive,
  getArchiveByPath,
  clearArchive,
} from '../store/worktreeArchives.js';

export interface ArchiveTarget {
  ticketId: number;
  repoPath: string;
  path: string;
  branch: string;
  baseRef: string;
}

export interface ArchiveResult {
  outcome: 'archived' | 'skipped';
  reason?: string;
  archiveRef: string;
}

export interface RestoreResult {
  outcome: 'restored' | 'skipped';
  reason?: string;
}

function slugOf(branch: string): string {
  return branch.replace(/^karst\//, '');
}

/** Run a git command through the injected runner; throw on nonzero exit. Returns trimmed stdout. */
async function run(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const r = await runner(args, cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

/** True if git has a linked worktree registered at exactly `path` (async — no event-loop block). */
async function isRegistered(runner: GitRunner, repoPath: string, path: string): Promise<boolean> {
  const r = await runner(['worktree', 'list', '--porcelain'], repoPath);
  if (r.exitCode !== 0) return false;
  const want = canonicalPath(path);
  return r.stdout
    .split('\n')
    .some((line) => line.startsWith('worktree ') && canonicalPath(line.slice('worktree '.length)) === want);
}

/**
 * Archive a worktree: capture its uncommitted delta into refs/karst/archive/<slug>
 * (branch untouched — committed work already lives on the branch), then remove the
 * folder + git worktree via removeWorktree, and record a worktree_archives row.
 *
 * The worktree is deleted right after, so staging into its own index is harmless —
 * no throwaway index needed. `.gitignore` keeps node_modules/dist out of capture.
 * An orphan folder (present but unregistered) is skipped, never deleted.
 */
export async function archiveWorktree(
  runner: GitRunner,
  store: Store,
  allocator: PortAllocator,
  target: ArchiveTarget,
): Promise<ArchiveResult> {
  const { ticketId, repoPath, path, branch, baseRef } = target;

  if (!existsSync(path)) {
    return { outcome: 'skipped', reason: 'folder already gone', archiveRef: '' };
  }
  if (!(await isRegistered(runner, repoPath, path))) {
    return { outcome: 'skipped', reason: 'orphan folder (not a registered worktree)', archiveRef: '' };
  }

  const slug = slugOf(branch);
  const ref = `refs/karst/archive/${slug}`;

  await run(runner, path, ['add', '-A']);
  const tree = await run(runner, path, ['write-tree']);
  const headTree = await run(runner, path, ['rev-parse', 'HEAD^{tree}']);

  let archiveRef = '';
  if (tree !== headTree) {
    const commit = await run(runner, path, [
      '-c',
      'user.name=karst',
      '-c',
      'user.email=karst@local',
      'commit-tree',
      tree,
      '-p',
      'HEAD',
      '-m',
      `karst-archive:${slug}`,
    ]);
    await run(runner, path, ['update-ref', ref, commit]);
    archiveRef = ref;
  }

  const record: WorktreeRecord = {
    ticketId,
    repoPath,
    slug,
    path,
    branch,
    baseRef,
    depsMode: 'inherited',
    adopted: false,
  };
  removeWorktree(store, record, allocator);

  recordArchive(store, {
    ticketId,
    repo: repoPath,
    path,
    branch,
    baseRef,
    archiveRef,
    method: 'git-ref',
  });

  return { outcome: 'archived', archiveRef };
}

/**
 * Restore an archived worktree: recreate the git worktree from its surviving
 * branch at the original path, replay the uncommitted delta as unstaged edits,
 * then drop the ref + clear the row. If the branch is gone, skip loudly and keep
 * the ref so the delta stays recoverable — never recreate from base (that would
 * lose committed work).
 */
export async function restoreWorktree(
  runner: GitRunner,
  store: Store,
  target: { ticketId: number; path: string },
): Promise<RestoreResult> {
  const row = getArchiveByPath(store, target.ticketId, target.path);
  if (!row) return { outcome: 'skipped', reason: 'no archive record' };

  const branchExists = await runner(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`],
    row.repo,
  );
  if (branchExists.exitCode !== 0) {
    return {
      outcome: 'skipped',
      reason: `branch ${row.branch} is gone; uncommitted delta preserved at ${row.archiveRef || '(none)'}`,
    };
  }

  const slug = slugOf(row.branch);
  createWorktree(store, {
    ticketId: row.ticketId,
    repoPath: row.repo,
    slug,
    baseRef: row.baseRef ?? row.branch,
  });

  if (row.archiveRef) {
    // cherry-pick -n applies parent->commit (== the uncommitted delta, since the
    // archive commit's parent is the branch tip) into worktree + index; reset
    // unstages it and clears CHERRY_PICK_HEAD.
    await run(runner, row.path, ['cherry-pick', '-n', row.archiveRef]);
    await run(runner, row.path, ['reset', '-q', 'HEAD']);
    await run(runner, row.repo, ['update-ref', '-d', row.archiveRef]);
  }

  clearArchive(store, row.id);
  return { outcome: 'restored' };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/runtime/archive.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/archive.ts src/runtime/archive.test.ts
git commit -m "feat(runtime): archive/restore worktrees via git-ref WIP snapshot"
```

---

### Task 4: Bulk archive (`archiveBulk.ts`)

**Files:**
- Create: `src/runtime/archiveBulk.ts`
- Test: `src/runtime/archiveBulk.test.ts`

**Interfaces:**
- Consumes: `archiveWorktree` (Task 3); `listArchivableWorktrees` (Task 2); `GitRunner`; `PortAllocator`.
- Produces:
  - `interface BulkSummary { archived: number; skipped: number; failed: number }`
  - `archiveInactiveWorktrees(runner: GitRunner, store: Store, allocator: PortAllocator): Promise<BulkSummary>`

- [ ] **Step 1: Write the failing test**

Create `src/runtime/archiveBulk.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { makePortAllocator } from '../resolver/allocator.js';
import { defaultGitRunner } from '../integrations/git.js';
import { createTicket } from '../store/tickets.js';
import { createWorktree } from './worktree.js';
import { archiveInactiveWorktrees } from './archiveBulk.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-bulk-'));
  writeFileSync(join(dir, 'index.js'), 'console.log(1);\n');
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 'test@karst.local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('archiveInactiveWorktrees', () => {
  let store: Store;
  let repo: { path: string; cleanup: () => void };
  beforeEach(() => {
    store = openStore(':memory:');
    repo = makeRepo();
  });
  afterEach(() => {
    store.close();
    repo.cleanup();
  });

  it('archives archived + done tickets, skips the active one', async () => {
    const arch = createTicket(store, { key: 'A', title: 'a', source: 'manual' });
    const done = createTicket(store, { key: 'D', title: 'd', source: 'manual' });
    const active = createTicket(store, { key: 'X', title: 'x', source: 'manual' });

    for (const [t, key] of [[arch, 'A'], [done, 'D'], [active, 'X']] as const) {
      createWorktree(store, { ticketId: t.id, repoPath: repo.path, slug: key, baseRef: 'develop' });
    }
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(arch.id);
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(done.id);

    const alloc = makePortAllocator(store, { start: 4000, end: 4100 });
    const summary = await archiveInactiveWorktrees(defaultGitRunner, store, alloc);

    expect(summary.archived).toBe(2);
    expect(summary.failed).toBe(0);
    // active ticket's worktree row survives
    const remaining = store.db.prepare('SELECT COUNT(*) AS n FROM worktrees').get() as { n: number };
    expect(remaining.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/runtime/archiveBulk.test.ts`
Expected: FAIL — `archiveBulk.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/runtime/archiveBulk.ts`:

```typescript
import type { Store } from '../store/db.js';
import type { GitRunner } from '../integrations/git.js';
import type { PortAllocator } from '../resolver/allocator.js';
import { archiveWorktree } from './archive.js';
import { listArchivableWorktrees } from '../store/worktreeArchives.js';

export interface BulkSummary {
  archived: number;
  skipped: number;
  failed: number;
}

/**
 * Archive every inactive worktree (ticket archived or done, agent not running),
 * deduped by folder path so repository entries sharing a repoPath archive once.
 * Sequential and fault-isolated: one item's failure never aborts the rest.
 */
export async function archiveInactiveWorktrees(
  runner: GitRunner,
  store: Store,
  allocator: PortAllocator,
): Promise<BulkSummary> {
  const candidates = listArchivableWorktrees(store);
  const seen = new Set<string>();
  const summary: BulkSummary = { archived: 0, skipped: 0, failed: 0 };

  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    try {
      const r = await archiveWorktree(runner, store, allocator, c);
      if (r.outcome === 'archived') summary.archived += 1;
      else summary.skipped += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/runtime/archiveBulk.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/archiveBulk.ts src/runtime/archiveBulk.test.ts
git commit -m "feat(runtime): bulk-archive inactive worktrees"
```

---

### Task 5: Extension wiring + command contribution

**Files:**
- Modify: `src/extension.ts` (imports; `karst.archiveTicket` and `karst.unarchiveTicket` handlers; new `karst.archiveInactiveWorktrees` command)
- Modify: `package.json` (`contributes.commands` — add the bulk command)

**Interfaces:**
- Consumes: `archiveWorktree`, `restoreWorktree` (Task 3); `archiveInactiveWorktrees` (Task 4); `listArchives` (Task 2); `listWorktreesByTicket` (existing, `./store/dashboard.js`); `makePortAllocator` (`./resolver/allocator.js`); `defaultGitRunner` (`./integrations/git.js`).
- Produces: no new module exports (host wiring only).

This task has no unit test (it imports `vscode`, which does not load under vitest — CLAUDE.md). Verification is `npm run typecheck` + `npm test` (whole suite still green) + the manual smoke test in Step 5.

- [ ] **Step 1: Add imports to `src/extension.ts`**

Near the existing `listWorktreesByTicket` import (line 49) and the `archiveTicket` import (line 91), add:

```typescript
import { archiveWorktree, restoreWorktree } from './runtime/archive.js';
import { archiveInactiveWorktrees } from './runtime/archiveBulk.js';
import { listArchives } from './store/worktreeArchives.js';
import { makePortAllocator } from './resolver/allocator.js';
import { defaultGitRunner } from './integrations/git.js';
```

(If any of these are already imported for another use, merge rather than duplicate.)

- [ ] **Step 2: Extend the `karst.archiveTicket` handler**

Replace the existing handler (lines 1278-1283) with an async version that also archives the ticket's worktree folders:

```typescript
    vscode.commands.registerCommand('karst.archiveTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      archiveTicket(localStore, ticketId);
      const manifest = currentManifest();
      if (manifest) {
        const allocator = makePortAllocator(localStore, manifest.portRange);
        for (const w of listWorktreesByTicket(localStore, ticketId)) {
          if (!w.branch) continue;
          try {
            await archiveWorktree(defaultGitRunner, localStore, allocator, {
              ticketId,
              repoPath: w.repo,
              path: w.path,
              branch: w.branch,
              baseRef: w.baseRef ?? w.branch,
            });
          } catch (err) {
            channel.appendLine(`archive worktree failed for ${w.path}: ${String(err)}`);
          }
        }
      }
      provider.refresh();
    }),
```

- [ ] **Step 3: Extend the `karst.unarchiveTicket` handler**

Replace the existing handler (lines 1284-1289) with an async version that restores archived worktrees first, then clears the ticket flag:

```typescript
    vscode.commands.registerCommand('karst.unarchiveTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      for (const a of listArchives(localStore, ticketId)) {
        try {
          const r = await restoreWorktree(defaultGitRunner, localStore, { ticketId, path: a.path });
          if (r.outcome === 'skipped') {
            void vscode.window.showWarningMessage(`Worktree not restored: ${r.reason ?? 'unknown reason'}`);
          }
        } catch (err) {
          channel.appendLine(`restore worktree failed for ${a.path}: ${String(err)}`);
        }
      }
      unarchiveTicket(localStore, ticketId);
      provider.refresh();
    }),
```

- [ ] **Step 4: Register the bulk command**

Add this command registration next to the others (e.g. after the `karst.deleteTicket` handler, ~line 1304):

```typescript
    vscode.commands.registerCommand('karst.archiveInactiveWorktrees', async () => {
      const manifest = currentManifest();
      if (!manifest) {
        void vscode.window.showWarningMessage('Karst: no manifest loaded.');
        return;
      }
      const allocator = makePortAllocator(localStore, manifest.portRange);
      const summary = await archiveInactiveWorktrees(defaultGitRunner, localStore, allocator);
      void vscode.window.showInformationMessage(
        `Karst: archived ${summary.archived} worktree(s), skipped ${summary.skipped}, failed ${summary.failed}.`,
      );
      provider.refresh();
    }),
```

- [ ] **Step 5: Add the command to `package.json`**

In `contributes.commands`, after the `karst.deleteTicket` entry (lines 113-117), add:

```json
      {
        "command": "karst.archiveInactiveWorktrees",
        "title": "Karst: Archive Inactive Worktrees",
        "icon": "$(archive)"
      },
```

- [ ] **Step 6: Verify types + whole suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: all tests pass (existing + the three new suites).

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat(extension): archive worktree folders on ticket archive + bulk command"
```

---

## Self-Review

**Spec coverage:**
- AC1 (archive removes from active pile) → Task 3 `archiveWorktree` → `removeWorktree`. ✓
- AC2 (full restore) → Task 3 `restoreWorktree` (branch + cherry-pick replay). ✓
- AC3 (space-efficient) → capture is a git ref (delta objects only); folder removed. ✓
- AC4 (no committed/uncommitted loss) → branch never mutated; capture-before-remove; branch-gone → skip + keep ref (Task 3). ✓
- AC5 (documented) → spec doc committed. ✓
- AC6 (handles backlog) → Task 4 bulk + Task 5 command; per-ticket via Task 5 archiveTicket wiring. ✓
- Schema checklist → Task 1 (schema.sql + migration + version + db.test). ✓
- Event-loop invariant → all archive/restore/bulk git via async `GitRunner`. ✓

**Placeholder scan:** none — every code step carries full code; every run step has a command + expected result.

**Type consistency:** `ArchiveTarget`/`ArchiveResult`/`RestoreResult`/`BulkSummary`/`ArchiveRow`/`NewArchive`/`ArchivableWorktree` names and fields are identical across the tasks that define and consume them. `archiveWorktree`/`restoreWorktree`/`archiveInactiveWorktrees`/`listArchivableWorktrees`/`recordArchive`/`getArchiveByPath`/`clearArchive`/`listArchives` signatures match between producer and consumer tasks. `WorktreeView` fields used in Task 5 (`repo`, `path`, `branch`, `baseRef`) match `src/store/dashboard.ts`.

**Note for implementer:** the Task 3 orphan-skip test is deliberately loose (it asserts only `outcome === 'skipped'` for a non-worktree path). If it proves brittle, simplify it to a single `existsSync=false`/unregistered path — the behavior under test is "never delete a folder git cannot restore."
