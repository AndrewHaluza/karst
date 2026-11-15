import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { createConflictRounds } from './autoDeliverOps.js';
import { resumeFinishedMerge, type ResumeDeps } from './conflictResumeOps.js';

let store: Store;
let id: number;

function seed(state: 'clean' | 'conflicted', headSha: string, prHead: string | null): void {
  store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_oid) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'r', 5, 'https://github.com/o/r/pull/5', 'open', prHead);
  setMergeCheck(store, { ticketId: id, repo: 'r', state, files: ['a.ts'], reason: null, headSha, baseSha: 'base1', baseRef: 'develop', checkedAt: 'x' });
}

function deps(over: Partial<ResumeDeps> = {}): ResumeDeps & { start: ReturnType<typeof vi.fn> } {
  const start = vi.fn();
  return {
    store, ticketId: id, rounds: createConflictRounds(),
    targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'b', cwd: '/w/r' }] }),
    headOf: async () => 'local', verify: async () => null, startDeliver: start, debug: () => {},
    ...over, start,
  };
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'R-1', title: 't' }).id;
  store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w/r', 'b');
});

describe('resumeFinishedMerge', () => {
  it('re-arms the round from the stored check and starts the deliver', async () => {
    seed('conflicted', 'older', 'pr');
    const d = deps();
    const verify = vi.fn(async () => null);
    expect(await resumeFinishedMerge({ ...d, verify }, true)).toBe('started');
    expect(verify).toHaveBeenCalledWith('/w/r', { repo: 'r', baseSha: 'base1', files: ['a.ts'] });
    expect(d.rounds.armed(id)).toEqual({ repo: 'r', baseSha: 'base1', files: ['a.ts'] });
    expect(d.start).toHaveBeenCalledTimes(1);
  });

  it('reports an unfinished merge and arms nothing', async () => {
    seed('conflicted', 'older', 'pr');
    const d = deps({ verify: async () => 'conflict markers remain in a.ts' });
    expect(await resumeFinishedMerge(d, true)).toBe('unfinished');
    expect(d.rounds.armed(id)).toBeNull();
    expect(d.start).not.toHaveBeenCalled();
  });

  it('reports none when the local head is the PR head', async () => {
    seed('conflicted', 'older', 'local');
    const d = deps();
    expect(await resumeFinishedMerge(d, true)).toBe('none');
    expect(d.start).not.toHaveBeenCalled();
  });

  it('waits when the PR head was never probed', async () => {
    seed('conflicted', 'older', null);
    expect(await resumeFinishedMerge(deps(), true)).toBe('wait');
  });

  it('without a slot, delivers only a clean check of the local head', async () => {
    seed('clean', 'local', 'pr');
    const d = deps();
    expect(await resumeFinishedMerge(d, false)).toBe('started');
    expect(d.start).toHaveBeenCalledTimes(1);
  });

  it('without a slot, ignores a stale conflicted row and a clean check of another head', async () => {
    seed('conflicted', 'older', 'pr');
    const a = deps();
    expect(await resumeFinishedMerge(a, false)).toBe('none');
    store.db.prepare('DELETE FROM prs').run();
    seed('clean', 'other', 'pr');
    const b = deps();
    expect(await resumeFinishedMerge(b, false)).toBe('none');
    expect(a.start).not.toHaveBeenCalled();
    expect(b.start).not.toHaveBeenCalled();
  });

  it('reports none when no PR can be delivered', async () => {
    expect(await resumeFinishedMerge(deps({ targets: () => ({ available: false, reason: 'no-open-pr' }) }), true)).toBe('none');
  });
});
