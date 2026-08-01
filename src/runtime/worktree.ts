import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { Store } from '../store/db.js';
import type { PortAllocator } from '../resolver/allocator.js';
import { prepareCommand } from './command.js';
import { KARST_EXCLUDE_RULES } from './karstExcludes.js';

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

/**
 * Canonicalize a path for equality against `git worktree list` output. git prints
 * the real (symlink-resolved) path — e.g. macOS `/var/…` → `/private/var/…` — so a
 * raw `join()`-built path won't string-match. Resolves the deepest existing
 * ancestor, then re-appends the missing tail, so it works whether or not the leaf
 * exists yet.
 */
export function canonicalPath(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return p; // reached root without an existing ancestor
    tail.unshift(basename(head));
    head = parent;
  }
  const base = realpathSync(head);
  return tail.length ? join(base, ...tail) : base;
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

/** True if git already has a linked worktree registered at exactly `path`. */
export function worktreeRegisteredAt(repoPath: string, path: string): boolean {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) return false;
  const want = canonicalPath(path);
  return r.stdout
    .split('\n')
    .some((line) => line.startsWith('worktree ') && canonicalPath(line.slice('worktree '.length)) === want);
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
           VALUES (?, ?, ?, ?, ?, 'inherited')`,
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
       VALUES (?, ?, ?, ?, ?, 'inherited')`,
    )
    .run(ticketId, repoPath, path, branch, baseRef);

  return record;
}

/**
 * Tear down a worktree: remove it via git, delete its `worktrees` row, and
 * release the ticket's port allocations [L5] so ports free on teardown (§8.4).
 */
export function removeWorktree(
  store: Store,
  record: WorktreeRecord,
  allocator: PortAllocator,
): void {
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
