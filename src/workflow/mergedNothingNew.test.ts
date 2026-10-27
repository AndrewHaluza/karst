import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import type { GhRunner } from '../integrations/github.js';
import type { GitRunner } from '../integrations/git.js';
import { transition } from './machine.js';
import { getTicket } from '../store/tickets.js';
import { adoptMergedPr, currentMergedPrNumber, probeMergedNothingNew, settleMergedNothingNew } from './mergedNothingNew.js';

function seedPr(store: Store, ticketId: number, status: string, number: number): void {
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, 'r', number, `https://github.com/o/r/pull/${number}`, status);
}

const MERGED = 'a'.repeat(40);

function runners(opts: { head: string; ghOut?: string; ghExit?: number; diffExit?: number }) {
  const ghCalls: string[][] = [];
  const gh: GhRunner = async (args) => {
    ghCalls.push(args);
    return { stdout: `${opts.ghOut ?? MERGED}\n`, stderr: '', exitCode: opts.ghExit ?? 0 };
  };
  const git: GitRunner = async (args) => {
    if (args[0] === 'rev-parse') return { stdout: `${opts.head}\n`, stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: opts.diffExit ?? 1 };
  };
  return { gh, git, ghCalls };
}

describe('probeMergedNothingNew', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T', title: 't' }).id;
  });

  it('is null without a merged current PR and never calls gh', async () => {
    seedPr(store, ticketId, 'open', 3);
    const { gh, git, ghCalls } = runners({ head: MERGED });
    expect(await probeMergedNothingNew({ store, git, gh }, ticketId, 'r', '/w')).toBeNull();
    expect(ghCalls).toEqual([]);
  });

  it('lands when HEAD equals the re-probed merged head', async () => {
    seedPr(store, ticketId, 'merged', 3);
    const { gh, git, ghCalls } = runners({ head: MERGED });
    expect(await probeMergedNothingNew({ store, git, gh }, ticketId, 'r', '/w')).toEqual({ number: 3, url: 'https://github.com/o/r/pull/3', source: 'store' });
    expect(ghCalls[0]).toContain('headRefOid');
  });

  it('lands when HEAD differs but the content diff is empty', async () => {
    seedPr(store, ticketId, 'merged', 3);
    const { gh, git } = runners({ head: 'b'.repeat(40), diffExit: 0 });
    expect(await probeMergedNothingNew({ store, git, gh }, ticketId, 'r', '/w')).toEqual({ number: 3, url: 'https://github.com/o/r/pull/3', source: 'store' });
  });

  it('is null when new content exists after the merge', async () => {
    seedPr(store, ticketId, 'merged', 3);
    const { gh, git } = runners({ head: 'b'.repeat(40), diffExit: 1 });
    expect(await probeMergedNothingNew({ store, git, gh }, ticketId, 'r', '/w')).toBeNull();
  });

  it('is null when gh cannot report the head', async () => {
    seedPr(store, ticketId, 'merged', 3);
    const { gh, git } = runners({ head: MERGED, ghExit: 1 });
    expect(await probeMergedNothingNew({ store, git, gh }, ticketId, 'r', '/w')).toBeNull();
  });

  it('ignores a merged PR superseded by a newer open one', () => {
    seedPr(store, ticketId, 'merged', 3);
    seedPr(store, ticketId, 'open', 5);
    expect(currentMergedPrNumber(store, ticketId, 'r')).toBeNull();
  });
});

describe('settleMergedNothingNew', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T', title: 't' }).id;
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) {
      transition(store, ticketId, from, { kind: 'passed' });
    }
    store.db
      .prepare(`INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, 'r', '/w', 'b', 'develop', 'inherited')`)
      .run(ticketId);
  });

  const cleanGit = (head: string): GitRunner => async (args) =>
    args[0] === 'rev-parse'
      ? { stdout: `${head}\n`, stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 };

  it('passes a ship slot waiting on confirm once its PR merged with nothing new', async () => {
    seedPr(store, ticketId, 'merged', 3);
    const { gh } = runners({ head: MERGED });
    const ids = await settleMergedNothingNew({ store, git: cleanGit(MERGED), gh });
    expect(ids).toEqual([ticketId]);
    expect(getTicket(store, ticketId).stageCurrent).not.toBe('ship');
  });

  it('leaves the ticket at ship when the merged branch has new work', async () => {
    seedPr(store, ticketId, 'merged', 3);
    const { gh } = runners({ head: MERGED });
    const git: GitRunner = async (args) =>
      args[0] === 'rev-parse'
        ? { stdout: `${'b'.repeat(40)}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    expect(await settleMergedNothingNew({ store, git, gh })).toEqual([]);
    expect(getTicket(store, ticketId).stageCurrent).toBe('ship');
  });
});

describe('GitHub fallback (hand-opened PR, no store row)', () => {
  let store: Store;
  let ticketId: number;
  const hint = { branch: 'b', baseRef: 'develop' };
  const pr = (over: Record<string, unknown> = {}) => ({
    number: 9,
    url: 'https://github.com/o/r/pull/9',
    headRefOid: MERGED,
    baseRefName: 'develop',
    mergedAt: '2026-01-02T00:00:00Z',
    headRepositoryOwner: { login: 'o' },
    ...over,
  });
  const rig = (list: string, head = MERGED, listExit = 0) => {
    const ghCalls: string[][] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[1] === 'view') return { stdout: `${MERGED}\n`, stderr: '', exitCode: 0 };
      return { stdout: list, stderr: '', exitCode: listExit };
    };
    const git: GitRunner = async (args) => {
      if (args[0] === 'rev-parse') return { stdout: `${head}\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'remote') return { stdout: 'git@github.com:o/r.git\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 1 };
    };
    return { gh, git, ghCalls };
  };
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T', title: 't' }).id;
  });
  const probe = (r: ReturnType<typeof rig>, h: typeof hint | null = hint) =>
    probeMergedNothingNew({ store, git: r.git, gh: r.gh }, ticketId, 'r', '/w', h ?? undefined);

  it('finds the merged PR, read-only', async () => {
    const r = rig(JSON.stringify([pr()]));
    expect(await probe(r)).toEqual({ number: 9, url: 'https://github.com/o/r/pull/9', source: 'github' });
    expect(r.ghCalls[0]).toEqual(expect.arrayContaining(['list', '--state', 'merged']));
    expect(store.db.prepare('SELECT COUNT(*) c FROM prs').get()).toEqual({ c: 0 });
  });

  it('takes the newest merge and ignores other bases and forks', async () => {
    const r = rig(JSON.stringify([
      pr({ number: 1, mergedAt: '2026-01-01T00:00:00Z' }),
      pr({ number: 2, baseRefName: 'main', mergedAt: '2026-03-01T00:00:00Z' }),
      pr({ number: 3, headRepositoryOwner: { login: 'fork' }, mergedAt: '2026-04-01T00:00:00Z' }),
    ]));
    expect((await probe(r))?.number).toBe(1);
  });

  it('is null for a different base only', async () => {
    expect(await probe(rig(JSON.stringify([pr({ baseRefName: 'main' })])))).toBeNull();
  });

  it('is null when the branch has commits after the merged head', async () => {
    expect(await probe(rig(JSON.stringify([pr()]), 'b'.repeat(40)))).toBeNull();
  });

  it('is null on gh failure, bad JSON, or no hint', async () => {
    expect(await probe(rig('[]', MERGED, 1))).toBeNull();
    expect(await probe(rig('not json'))).toBeNull();
    const r = rig(JSON.stringify([pr()]));
    expect(await probe(r, null)).toBeNull();
    expect(r.ghCalls).toEqual([]);
  });

  it('does not ask GitHub once the store has a row', async () => {
    const r = rig(JSON.stringify([pr()]));
    const first = await probe(r);
    adoptMergedPr(store, ticketId, 'r', first!);
    adoptMergedPr(store, ticketId, 'r', first!);
    expect(store.db.prepare('SELECT status FROM prs').all()).toEqual([{ status: 'merged' }]);
    r.ghCalls.length = 0;
    const again = await probe(r);
    expect(again?.source).toBe('store');
    expect(r.ghCalls.every((c) => c[1] !== 'list')).toBe(true);
  });

  it('settle adopts a hand-merged single-repo ticket waiting at ship', async () => {
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) {
      transition(store, ticketId, from, { kind: 'passed' });
    }
    store.db
      .prepare(`INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, 'r', '/w', 'b', 'develop', 'inherited')`)
      .run(ticketId);
    const r = rig(JSON.stringify([pr()]));
    const git: GitRunner = async (args) =>
      args[0] === 'status' ? { stdout: '', stderr: '', exitCode: 0 } : r.git(args, '/w');
    expect(await settleMergedNothingNew({ store, git, gh: r.gh })).toEqual([ticketId]);
    expect(store.db.prepare('SELECT status FROM prs').all()).toEqual([{ status: 'merged' }]);
  });
});
