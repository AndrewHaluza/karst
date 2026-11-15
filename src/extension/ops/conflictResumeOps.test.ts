import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { getConflictRoundAt } from '../../store/autopilot.js';
import { createConflictRounds } from './autoDeliverOps.js';
import { resumeFinishedMerge, type ResumeDeps } from './conflictResumeOps.js';

let store: Store;
let id: number;

function seed(state: 'clean' | 'conflicted', headSha: string, prHead: string | null, block: string | null = null): void {
  store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_oid, merge_block) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'r', 5, 'https://github.com/o/r/pull/5', 'open', prHead, block);
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

  it('without a slot, delivers a clean check of the local head while GitHub reports the PR dirty', async () => {
    seed('clean', 'local', 'pr', 'dirty');
    const d = deps();
    expect(await resumeFinishedMerge(d, false)).toBe('started');
    expect(d.start).toHaveBeenCalledTimes(1);
    // The hand merge takes a stored slot, so a failed deliver stalls and parks instead of staying armed forever.
    expect(getConflictRoundAt(store, id)).not.toBeNull();
  });

  it('never delivers an ordinary unpushed commit (the PR is not dirty)', async () => {
    seed('clean', 'local', 'pr', 'clean');
    const d = deps();
    expect(await resumeFinishedMerge(d, false)).toBe('none');
    expect(await resumeFinishedMerge(d, true)).toBe('none');
    expect(d.start).not.toHaveBeenCalled();
  });

  it('with a slot, arms only the conflicted repo', async () => {
    seed('clean', 'local', 'pr', 'clean');
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'o', '/w/o', 'b');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_oid) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'o', 6, 'https://github.com/o/o/pull/6', 'open', 'pr');
    setMergeCheck(store, { ticketId: id, repo: 'o', state: 'conflicted', files: ['b.ts'], reason: null, headSha: 'older', baseSha: 'base2', baseRef: 'develop', checkedAt: 'x' });
    const d = deps({ targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'b', cwd: '/w/r' }, { repo: 'o', number: 6, branch: 'b', cwd: '/w/o' }] }) });
    expect(await resumeFinishedMerge(d, true)).toBe('started');
    expect(d.rounds.armed(id)).toEqual({ repo: 'o', baseSha: 'base2', files: ['b.ts'] });
  });

  it('without a slot, ignores a stale conflicted row and a clean check of another head', async () => {
    seed('conflicted', 'older', 'pr');
    const a = deps();
    expect(await resumeFinishedMerge(a, false)).toBe('none');
    store.db.prepare('DELETE FROM prs').run();
    seed('clean', 'other', 'pr', 'dirty');
    const b = deps();
    expect(await resumeFinishedMerge(b, false)).toBe('none');
    expect(a.start).not.toHaveBeenCalled();
    expect(b.start).not.toHaveBeenCalled();
  });

  it('reports none when no PR can be delivered', async () => {
    expect(await resumeFinishedMerge(deps({ targets: () => ({ available: false, reason: 'no-open-pr' }) }), true)).toBe('none');
  });
});
