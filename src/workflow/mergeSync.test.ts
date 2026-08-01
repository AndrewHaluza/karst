import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { listMergeChecksByTicket, setMergeCheck } from '../store/mergeChecks.js';
import type { GitRunner, GitResult } from '../integrations/git.js';
import { syncMergeChecks } from './mergeSync.js';

function seedPr(store: Store, ticketId: number, repo: string, number: number, status: string): void {
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, number, `https://github.com/o/r/pull/${number}`, status);
}

function seedWorktree(store: Store, ticketId: number, repo: string, path: string, baseRef = 'main'): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, path, `karst/${repo}`, baseRef);
}

/** Runner keyed by git subcommand, recording every invocation. */
function scriptedGit(
  replies: Record<string, Partial<GitResult>>,
): { git: GitRunner; seen: Array<{ args: string[]; cwd: string }> } {
  const seen: Array<{ args: string[]; cwd: string }> = [];
  const git: GitRunner = async (args, cwd) => {
    seen.push({ args, cwd: cwd ?? '' });
    const key = args.find((a) => !a.startsWith('-')) ?? args[0]!;
    const r = replies[key] ?? replies[args[0]!] ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  };
  return { git, seen };
}

const HEALTHY = { fetch: { exitCode: 0 }, 'rev-parse': { stdout: 'abc1234\n' } };
const CLEAN = { ...HEALTHY, 'merge-tree': { exitCode: 0 } };
/**
 * `git merge-tree --write-tree --name-only` as git actually prints it: the tree
 * OID, then the conflicted paths on the very next lines, then a blank line, then
 * git's informational messages. Verbatim from git 2.50 — a fixture that invents
 * a friendlier layout is what let a parser that read the messages as filenames
 * pass its own tests.
 */
const MERGE_TREE_CONFLICT =
  '9f2c\nsrc/a.ts\nsrc/b.ts\n\nAuto-merging src/a.ts\n' +
  'CONFLICT (content): Merge conflict in src/a.ts\n';
const CONFLICTED = {
  ...HEALTHY,
  'merge-tree': { exitCode: 1, stdout: MERGE_TREE_CONFLICT },
};

describe('syncMergeChecks', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  // The whole point of the sweep: ship recorded 'clean', then the base moved and
  // nobody re-asked. A conflict that appears after the PR is open is exactly the
  // one a human otherwise discovers at merge time.
  it('flips a stale clean to conflicted once the base has moved under the PR', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, t.id, 'api', 12, 'open');
    seedWorktree(store, t.id, 'api', '/wt/api');
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'clean',
      files: [],
      reason: null,
      headSha: 'old',
      baseSha: 'old',
      baseRef: 'main',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });

    const { git } = scriptedGit(CONFLICTED);
    const changed = await syncMergeChecks(store, git, { scope: { projectId: 1 } });

    expect(changed).toBe(1);
    const row = listMergeChecksByTicket(store, t.id)[0]!;
    expect(row.state).toBe('conflicted');
    expect(row.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('records a first check for a PR that never had one', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, t.id, 'api', 12, 'open');
    seedWorktree(store, t.id, 'api', '/wt/api');

    const { git } = scriptedGit(CONFLICTED);
    const changed = await syncMergeChecks(store, git, { scope: { projectId: 1 } });

    expect(changed).toBe(1);
    expect(listMergeChecksByTicket(store, t.id)[0]!.state).toBe('conflicted');
  });

  // A re-probe that lands on the same verdict is not news. Counting it would
  // refresh the dashboard on every tick forever.
  it('reports no change when the verdict is the one already stored', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, t.id, 'api', 12, 'open');
    seedWorktree(store, t.id, 'api', '/wt/api');
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'clean',
      files: [],
      reason: null,
      headSha: 'a',
      baseSha: 'b',
      baseRef: 'main',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });

    const { git } = scriptedGit(CLEAN);
    const changed = await syncMergeChecks(store, git, { scope: { projectId: 1 } });

    expect(changed).toBe(0);
    expect(listMergeChecksByTicket(store, t.id)[0]!.state).toBe('clean');
  });

  // Freshness beats fetch traffic: the sweep rides a 60s PR tick, and fetching
  // every base every minute would hammer the remote for an answer that barely
  // moves. A row younger than the floor is left alone — and left UNPROBED.
  it('skips a repo whose stored check is younger than the age floor', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, t.id, 'api', 12, 'open');
    seedWorktree(store, t.id, 'api', '/wt/api');
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'clean',
      files: [],
      reason: null,
      headSha: 'a',
      baseSha: 'b',
      baseRef: 'main',
      checkedAt: '2026-07-28T12:00:00.000Z',
    });

    const { git, seen } = scriptedGit(CONFLICTED);
    const changed = await syncMergeChecks(store, git, {
      scope: { projectId: 1 },
      minAgeMs: 5 * 60_000,
      now: () => '2026-07-28T12:01:00.000Z',
    });

    expect(changed).toBe(0);
    expect(seen).toEqual([]);
    expect(listMergeChecksByTicket(store, t.id)[0]!.state).toBe('clean');
  });

  it('re-probes once the stored check is older than the age floor', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, t.id, 'api', 12, 'open');
    seedWorktree(store, t.id, 'api', '/wt/api');
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'clean',
      files: [],
      reason: null,
      headSha: 'a',
      baseSha: 'b',
      baseRef: 'main',
      checkedAt: '2026-07-28T12:00:00.000Z',
    });

    const { git } = scriptedGit(CONFLICTED);
    const changed = await syncMergeChecks(store, git, {
      scope: { projectId: 1 },
      minAgeMs: 5 * 60_000,
      now: () => '2026-07-28T12:06:00.000Z',
    });

    expect(changed).toBe(1);
    expect(listMergeChecksByTicket(store, t.id)[0]!.state).toBe('conflicted');
  });

  // An unparseable stored timestamp must not freeze a repo out of the sweep
  // forever — an unreadable age is no age at all, so probe it.
  it('probes a repo whose stored checkedAt cannot be parsed', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, t.id, 'api', 12, 'open');
    seedWorktree(store, t.id, 'api', '/wt/api');
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'clean',
      files: [],
      reason: null,
      headSha: 'a',
      baseSha: 'b',
      baseRef: 'main',
      checkedAt: 'not-a-date',
    });

    const { git } = scriptedGit(CONFLICTED);
    const changed = await syncMergeChecks(store, git, {
      scope: { projectId: 1 },
      minAgeMs: 5 * 60_000,
      now: () => '2026-07-28T12:06:00.000Z',
    });

    expect(changed).toBe(1);
  });

  // A merged PR is done moving; re-probing it is fetch traffic for an answer
  // nobody can act on. `listSyncablePrs` already excludes it — this pins that.
  it('leaves a merged PR alone', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, t.id, 'api', 12, 'merged');
    seedWorktree(store, t.id, 'api', '/wt/api');

    const { git, seen } = scriptedGit(CONFLICTED);
    const changed = await syncMergeChecks(store, git, { scope: { projectId: 1 } });

    expect(changed).toBe(0);
    expect(seen).toEqual([]);
    expect(listMergeChecksByTicket(store, t.id)).toEqual([]);
  });

  // Projects share one DB across IDE windows: window A must never fetch, probe,
  // or overwrite window B's tickets.
  it('never touches another project’s PR', async () => {
    const mine = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    const theirs = createTicket(store, { key: 'B', title: 'b', projectId: 2 });
    seedPr(store, mine.id, 'api', 12, 'open');
    seedWorktree(store, mine.id, 'api', '/wt/mine');
    seedPr(store, theirs.id, 'api', 34, 'open');
    seedWorktree(store, theirs.id, 'api', '/wt/theirs');

    const { git, seen } = scriptedGit(CONFLICTED);
    await syncMergeChecks(store, git, { scope: { projectId: 1 } });

    expect(listMergeChecksByTicket(store, theirs.id)).toEqual([]);
    expect(seen.every((c) => c.cwd === '/wt/mine')).toBe(true);
  });

  // The manifest's baseline is the authority ship itself uses; a worktree row
  // records the branch it was CUT from, which a re-baselined project outgrows.
  it('prefers the injected base ref over the one stored on the worktree', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, t.id, 'api', 12, 'open');
    seedWorktree(store, t.id, 'api', '/wt/api', 'main');

    const { git, seen } = scriptedGit(CLEAN);
    await syncMergeChecks(store, git, {
      scope: { projectId: 1 },
      baseRefFor: () => 'develop',
    });

    expect(seen[0]!.args).toEqual(['fetch', 'origin', 'develop']);
    expect(listMergeChecksByTicket(store, t.id)[0]!.baseRef).toBe('develop');
  });

  it('falls back to the worktree base ref when no resolver is injected', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, t.id, 'api', 12, 'open');
    seedWorktree(store, t.id, 'api', '/wt/api', 'develop');

    const { git, seen } = scriptedGit(CLEAN);
    await syncMergeChecks(store, git, { scope: { projectId: 1 } });

    expect(seen[0]!.args).toEqual(['fetch', 'origin', 'develop']);
  });

  // Same rule as ship: the probe is advisory. It must never be able to break the
  // sweep it rides on, so one failing repo leaves the rest still checked.
  it('keeps sweeping when one repo’s probe blows up', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, t.id, 'api', 12, 'open');
    seedPr(store, t.id, 'web', 34, 'open');
    seedWorktree(store, t.id, 'api', '/wt/api');
    seedWorktree(store, t.id, 'web', '/wt/web');

    const git: GitRunner = async (args, cwd) => {
      if (cwd === '/wt/api') throw new Error('boom');
      if (args[0] === 'merge-tree') return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: 'abc1234\n', stderr: '', exitCode: 0 };
    };

    const changed = await syncMergeChecks(store, git, { scope: { projectId: 1 } });

    // Both repos got a fresh verdict — the failing one an honest `unknown`.
    expect(changed).toBe(2);
    const rows = listMergeChecksByTicket(store, t.id);
    expect(rows.find((r) => r.repo === 'web')!.state).toBe('clean');
    // checkMergeable converts the throw into `unknown` — an honest non-answer,
    // never a silent clean.
    expect(rows.find((r) => r.repo === 'api')!.state).toBe('unknown');
  });
});
