import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import type { GhRunner } from '../integrations/github.js';
import type { GitRunner } from '../integrations/git.js';
import { transition } from './machine.js';
import { getTicket } from '../store/tickets.js';
import { currentMergedPrNumber, probeMergedNothingNew, settleMergedNothingNew } from './mergedNothingNew.js';

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
    expect(await probeMergedNothingNew({ store, git, gh }, ticketId, 'r', '/w')).toEqual({ number: 3 });
    expect(ghCalls[0]).toContain('headRefOid');
  });

  it('lands when HEAD differs but the content diff is empty', async () => {
    seedPr(store, ticketId, 'merged', 3);
    const { gh, git } = runners({ head: 'b'.repeat(40), diffExit: 0 });
    expect(await probeMergedNothingNew({ store, git, gh }, ticketId, 'r', '/w')).toEqual({ number: 3 });
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
