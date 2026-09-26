import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/db.js';
import type { PortAllocator } from '../resolver/allocator.js';
import { prepareCommand } from './command.js';
import { KARST_EXCLUDE_RULES } from './karstExcludes.js';
import { canonicalPath } from './pathScope.js';
import { stopServersUnder, type ReapedServer } from './worktreeServers.js';
import { runGit } from '../integrations/git.js';

// `canonicalPath` moved to the leaf `pathScope.ts` (this module now depends on
// `worktreeServers.ts`, which needs it too — keeping it here would be a cycle).
// Re-exported because every existing consumer imports it from this module.
export { canonicalPath } from './pathScope.js';

export interface WorktreeRecord {
  ticketId: number;
  repoPath: string;
  slug: string;
  path: string;
  branch: string;
  baseRef: string;
  depsMode: 'inherited' | 'local';
  /**
   * True when this record was adopted from a pre-existing worktree (a resumed
   * spin) rather than created by this call. Teardown-on-cancel removes only
   * freshly-created worktrees — never an adopted leftover the user may still want.
   */
  adopted: boolean;
}

/**
 * The fields `removeWorktree` actually acts on. A full `WorktreeRecord`
 * satisfies it, but a caller that only holds the `worktrees` columns removal
 * needs (permanent ticket delete, reading them back from `listWorktreesByTicket`)
 * can pass just these — the slug and the branch/base bookkeeping are irrelevant
 * to stopping the servers and taking the tree off disk.
 */
export interface RemovableWorktree {
  ticketId: number;
  repoPath: string;
  path: string;
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) {
    // Spawn-level failure (e.g. git not on PATH): status is null, no stdio.
    throw new Error(`git ${args.join(' ')} could not run in ${cwd}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
}

/**
 * The worktree filesystem path + branch name for a `<repoPath>` / `<slug>` pair.
 * Single source of truth for the derivation so `createWorktree` and
 * `preflightSpin` can never drift on where a worktree lands or what branch it
 * carries. `slug` is the ticket's worktree slug (key-or-id + title, see
 * `worktreeSlug`) — rename-invariant, one per ticket, and the PATH is always
 * derived from it (only the branch is configurable).
 *
 * `branch` is the value rendered from `conventions.branchName`
 * (`renderBranchName`). Omitted → the historical `karst/<slug>`, so a caller that
 * has no manifest in hand (and every pre-conventions caller) keeps its behavior.
 */
export function worktreePaths(
  repoPath: string,
  slug: string,
  branch?: string,
): { path: string; branch: string } {
  return {
    path: join(repoPath, '.karst', 'worktrees', slug),
    branch: branch && branch.trim() !== '' ? branch : `karst/${slug}`,
  };
}

/** True if a local branch `<branch>` already exists in `repoPath` (never throws). */
function branchExists(repoPath: string, branch: string): boolean {
  const r = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: repoPath, encoding: 'utf8' },
  );
  return !r.error && r.status === 0;
}

/** Does `git worktree list --porcelain` output register exactly `path`? */
function worktreeListHas(stdout: string, path: string): boolean {
  const want = canonicalPath(path);
  return stdout
    .split('\n')
    .some((line) => line.startsWith('worktree ') && canonicalPath(line.slice('worktree '.length)) === want);
}

/** True if git already has a linked worktree registered at exactly `path`. */
export function worktreeRegisteredAt(repoPath: string, path: string): boolean {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) return false;
  return worktreeListHas(r.stdout, path);
}

/**
 * Async `worktreeRegisteredAt` for the extension-host paths (Spin's baseline
 * start). Identical decision through the bounded, non-blocking `runGit`, so the
 * single event loop — every webview, the hook endpoint, every session — is never
 * frozen by a synchronous `git worktree list`.
 */
export async function worktreeRegisteredAtAsync(repoPath: string, path: string): Promise<boolean> {
  const r = await runGit(['worktree', 'list', '--porcelain'], repoPath);
  return r.exitCode === 0 && worktreeListHas(r.stdout, path);
}

/**
 * Ignore everything karst generates via `.git/info/exclude` — the untracked,
 * per-clone ignore file — so we never mutate the repo's tracked `.gitignore`
 * (default, §8.1). The file lives in the common git dir, so one write covers the
 * repository and every linked worktree cut from it.
 *
 * Idempotent AND additive: only the missing rules are appended, so a repository
 * whose exclude file predates a rule gains it without the older rules being
 * rewritten or duplicated.
 */
function ensureKarstExcluded(repoPath: string): void {
  const excludePath = join(repoPath, '.git', 'info', 'exclude');
  let contents = '';
  if (existsSync(excludePath)) contents = readFileSync(excludePath, 'utf8');
  const present = new Set(contents.split('\n').map((line) => line.trim()));
  const missing = KARST_EXCLUDE_RULES.filter((rule) => !present.has(rule));
  if (missing.length === 0) return;
  const sep = contents.length && !contents.endsWith('\n') ? '\n' : '';
  writeFileSync(excludePath, `${contents}${sep}${missing.join('\n')}\n`);
}

/**
 * Create a nested `.karst` worktree at `<repo>/.karst/worktrees/<slug>` on a new
 * branch off `baseRef` (§8.1). Deps resolve via ancestor walk to the parent
 * repo's node_modules — no install for the common case, so deps_mode starts
 * `inherited`. Records the row in `worktrees`.
 */
export function createWorktree(
  store: Store,
  opts: {
    ticketId: number;
    repoPath: string;
    slug: string;
    baseRef: string;
    /** Rendered branch name; omitted → `karst/<slug>` (see `worktreePaths`). */
    branch?: string;
    /**
     * Ref to cut the new branch FROM, when it differs from `baseRef` — a
     * just-refreshed `origin/<base>` whose local branch could not be
     * fast-forwarded (see `pullBaseRef`). `base_ref` still records the plain
     * `baseRef`: every other consumer (mergeCheck, the diff views, archive)
     * re-derives its own remote ref from that name, so storing `origin/…` here
     * would have them ask git about `origin/origin/develop`.
     */
    startPoint?: string;
  },
): WorktreeRecord {
  const { ticketId, repoPath, slug, baseRef } = opts;
  const startPoint = opts.startPoint && opts.startPoint.trim() !== '' ? opts.startPoint : baseRef;
  const { path, branch } = worktreePaths(repoPath, slug, opts.branch);

  // Adopt on retry: a prior spin that died after this step left the git worktree
  // behind. Re-running must not `git worktree add` over it (fails). If a DB row
  // is also present (the normal resume) reuse it as-is — the table has no
  // uniqueness, so re-INSERTing would duplicate. But the git worktree and the DB
  // row can drift out of sync: if the store was reset (or the row never landed)
  // while the on-disk worktree survived, there is no row and a bare return would
  // leave the ticket with a git worktree the store can't see (session launch then
  // reports "no worktree yet"). In that case INSERT the missing row.
  if (worktreeRegisteredAt(repoPath, path)) {
    // Re-ensure before the early return: a worktree cut by an older karst
    // carries only the rules that karst knew, and everything the newer rules
    // cover is still being written into it on every launch. Without this a
    // resumed ticket keeps shipping the leavings the rules were added to stop.
    ensureKarstExcluded(repoPath);
    const existing = store.db
      .prepare('SELECT branch, base_ref, deps_mode FROM worktrees WHERE ticket_id = ? AND path = ?')
      .get(ticketId, path) as
      | { branch: string | null; base_ref: string; deps_mode: string }
      | undefined;
    if (!existing) {
      store.db
        .prepare(
          `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
           VALUES (?, ?, ?, ?, ?, 'inherited')
           ON CONFLICT (ticket_id, path) DO NOTHING`,
        )
        .run(ticketId, repoPath, path, branch, baseRef);
    }
    return {
      ticketId,
      repoPath,
      slug,
      path,
      // The STORED branch wins for an adopted worktree: the checkout is on it,
      // and a `conventions.branchName` change since then renames nothing.
      branch: existing?.branch ?? branch,
      baseRef: existing?.base_ref ?? baseRef,
      depsMode: (existing?.deps_mode as 'inherited' | 'local') ?? 'inherited',
      adopted: true,
    };
  }

  ensureKarstExcluded(repoPath);
  // Reuse a leftover branch (prior aborted spin / teardown that kept the branch)
  // by attaching to it instead of failing. `-b` CREATES a branch and errors if it
  // exists; without `-b` we check out the existing one — and git forbids a
  // start-point (baseRef) when the branch already exists, so omit it too — which
  // is also why a refreshed `startPoint` only applies on the create path.
  if (branchExists(repoPath, branch)) {
    git(repoPath, ['worktree', 'add', '-q', path, branch]);
  } else {
    git(repoPath, ['worktree', 'add', '-q', '-b', branch, path, startPoint]);
  }

  // UPSERT, not a plain INSERT: git listing no worktree at `path` does not mean
  // the store has no row for it. A checkout pruned from git (deleted by hand, or
  // reaped while the row survived) reaches here with its row still present, and
  // a second INSERT would leave the ticket with two rows for one checkout — the
  // duplicated dashboard worktree cards. The unique index (v61) makes that
  // impossible; the checkout just cut is authoritative, so it refreshes the
  // row's branch and base ref while `created_at` stays the original.
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

  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, ?, ?, ?, ?, 'inherited')
       ON CONFLICT (ticket_id, path) DO UPDATE SET
         repo = excluded.repo, branch = excluded.branch, base_ref = excluded.base_ref`,
    )
    .run(ticketId, repoPath, path, branch, baseRef);

  return record;
}

/**
 * Tear down a worktree: stop the servers running inside it, remove it via git,
 * delete its `worktrees` row, and release the ticket's port allocations [L5] so
 * ports free on teardown (§8.4).
 *
 * The server stop comes FIRST and is not optional. Hot services are spawned
 * `detached` (their own session, no controlling tty), so once the tree is gone
 * nothing can reach them: they reparent to init, keep their port bound and their
 * memory held, and serve a directory that no longer exists — invisibly, because
 * the registry row leaves with the ticket (869ed2n50). This is the single choke
 * point for worktree removal, so archiving, bulk archiving and spin teardown all
 * inherit it. Best-effort by construction: `stopServersUnder` isolates each kill,
 * because cleanup must never fail a removal the user asked for.
 *
 * RETURNS what it stopped, and callers with somewhere to say it must say it — a
 * reap nothing reports is the failure mode this whole change exists to end. Spin
 * teardown is the one caller that legitimately ignores the value: it stops the
 * servers its own run started BEFORE removing anything, so by the time this runs
 * there is nothing left for it to find.
 */
export function removeWorktree(
  store: Store,
  record: RemovableWorktree,
  allocator: PortAllocator,
): ReapedServer[] {
  const reaped = stopServersUnder(store, record.path);
  try {
    // --force because the linked worktree may have untracked build artifacts.
    git(record.repoPath, ['worktree', 'remove', '--force', record.path]);
    if (existsSync(record.path)) rmSync(record.path, { recursive: true, force: true });

    store.db
      .prepare('DELETE FROM worktrees WHERE ticket_id = ? AND path = ?')
      .run(record.ticketId, record.path);
  } finally {
    // Ports free on teardown even if git/fs removal threw partway — otherwise a
    // failed removal would leak the ticket's allocation forever (§8.4).
    allocator.release(record.ticketId);
  }
  return reaped;
}

/**
 * Manual divergence action (§8.2): the ticket changed package.json/lockfile, so
 * this worktree needs its own node_modules to shadow the shared one. Runs a
 * local install and flips deps_mode to `local`.
 */
export function reinstallDeps(store: Store, record: WorktreeRecord): WorktreeRecord {
  const p = prepareCommand('npm', ['install', '--no-audit', '--no-fund']);
  const r = spawnSync(p.command, p.args, {
    cwd: record.path,
    encoding: 'utf8',
    windowsVerbatimArguments: p.windowsVerbatimArguments,
  });
  if (r.error) {
    throw new Error(`npm install could not run in ${record.path}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    // Never flip deps_mode to 'local' on a failed install — that would claim a
    // valid local node_modules the worktree doesn't have.
    throw new Error(`npm install failed in ${record.path}: ${r.stderr || r.stdout}`);
  }

  store.db
    .prepare("UPDATE worktrees SET deps_mode = 'local' WHERE ticket_id = ? AND path = ?")
    .run(record.ticketId, record.path);

  return { ...record, depsMode: 'local' };
}

/**
 * Resolve a worktree path back to its ticket id — the `worktree → ticket` join
 * key for the hook channel (§5.4). The hook payload's `cwd` IS the worktree
 * path; the daemon owns this mapping. Returns `null` for an unknown path so a
 * stray hook can't mutate an unrelated ticket.
 */
export function ticketIdForWorktreePath(store: Store, path: string): number | null {
  // The hook's `cwd` is realpath-resolved (git/Claude report the real path), but
  // the stored `path` is a raw `join()` — a symlinked repoPath would never match a
  // raw `WHERE path = ?`. Compare canonically on both sides (the worktrees table
  // is tiny, so a scan is fine) — the same reason `worktreeRegisteredAt` above
  // canonicalizes before comparing git's output.
  const want = canonicalPath(path);
  const rows = store.db
    .prepare('SELECT ticket_id, path FROM worktrees')
    .all() as { ticket_id: number; path: string }[];
  for (const r of rows) {
    if (canonicalPath(r.path) === want) return r.ticket_id;
  }
  return null;
}
