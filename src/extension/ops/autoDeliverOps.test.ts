import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import {
  armConflictRound,
  autoDeliverAfterConflict,
  createConflictRounds,
  verifyMergeResolved,
  type AutoDeliverDeps,
  type ResolvedRound,
} from './autoDeliverOps.js';
import type { DeliverTargets } from '../../workflow/deliverState.js';

const OPEN: DeliverTargets = { available: true, prs: [{ repo: 'karst', number: 7, branch: 'feat/x', cwd: '/wt' }] };
const ROUND: ResolvedRound = { repo: 'karst', baseSha: 'b4se', files: ['a.ts'] };

function rig(over: Partial<AutoDeliverDeps> = {}) {
  const rounds = createConflictRounds();
  rounds.arm(1, ROUND);
  const log: string[] = [];
  const deps: AutoDeliverDeps = {
    ticketId: 1,
    key: 'T1',
    rounds,
    targets: () => OPEN,
    agentActive: () => false,
    ensureSynced: async () => ({ ok: true }),
    verifyMerge: async () => null,
    runGates: async () => null,
    blocked: async () => undefined,
    runShip: async () => { log.push('ship'); },
    reprobe: async () => undefined,
    status: (m) => log.push(`status:${m}`),
    info: (m) => log.push(`info:${m}`),
    log: (m) => log.push(`log:${m}`),
    error: (m) => log.push(`error:${m}`),
    logError: () => undefined,
    afterServerChange: () => undefined,
    ...over,
  };
  return { deps, rounds, log };
}

describe('autoDeliverAfterConflict', () => {
  it('syncs, verifies, gates, pushes once, and disarms', async () => {
    const { deps, rounds, log } = rig();
    await autoDeliverAfterConflict(deps);
    expect(log.filter((l) => l === 'ship')).toHaveLength(1);
    expect(log).toContain('status:Delivering resolved merge to PR #7…');
    expect(log.some((l) => l.startsWith('log:[ship] ticket T1 auto-deliver after conflict resolve: delivered'))).toBe(true);
    expect(rounds.armed(1)).toBeNull();
    await autoDeliverAfterConflict(deps);
    expect(log.filter((l) => l === 'ship')).toHaveLength(1);
  });

  it('verifies the PR of the armed repo and gates every PR of the ticket', async () => {
    const prs = [
      { repo: 'other', number: 3, branch: 'b', cwd: '/o' },
      { repo: 'karst', number: 7, branch: 'feat/x', cwd: '/wt' },
    ];
    const verified: string[] = [];
    let gated = 0;
    const { deps, log } = rig({
      targets: () => ({ available: true, prs }),
      verifyMerge: async (pr) => { verified.push(pr.cwd); return null; },
      runGates: async (all) => { gated = all.length; return null; },
    });
    await autoDeliverAfterConflict(deps);
    expect(verified).toEqual(['/wt']);
    expect(gated).toBe(2);
    expect(log).toContain('status:Delivering resolved merge to PR #7…');
  });
  it('falls back to the first PR and names an unnumbered one', async () => {
    const { deps, log } = rig({ targets: () => ({ available: true, prs: [{ repo: 'x', number: null, branch: 'b', cwd: '/x' }] }) });
    await autoDeliverAfterConflict(deps);
    expect(log).toContain('status:Delivering resolved merge to PR #?…');
  });
  it('logs the refusal reason', async () => {
    const { deps, log } = rig({ verifyMerge: async () => 'dirty' });
    await autoDeliverAfterConflict(deps);
    expect(log).toContain('log:[ship] ticket T1 auto-deliver after conflict resolve: refused (dirty)');
  });

  it('does nothing for a ticket with no armed round (manual session)', async () => {
    const { deps, log } = rig({ rounds: createConflictRounds() });
    await autoDeliverAfterConflict(deps);
    expect(log).toEqual([]);
  });

  it('does nothing while the agent is running', async () => {
    const runShip = vi.fn();
    const { deps, rounds } = rig({ agentActive: () => true, runShip });
    await autoDeliverAfterConflict(deps);
    expect(runShip).not.toHaveBeenCalled();
    expect(rounds.armed(1)).not.toBeNull();
  });

  it('pushes nothing and says why when the merge is incomplete; stays armed', async () => {
    const runShip = vi.fn();
    const { deps, rounds, log } = rig({ verifyMerge: async () => 'worktree has uncommitted changes', runShip });
    await autoDeliverAfterConflict(deps);
    expect(runShip).not.toHaveBeenCalled();
    expect(log).toContain('error:conflict resolve did not finish: worktree has uncommitted changes');
    expect(rounds.armed(1)).not.toBeNull();
  });

  it('pushes nothing when a gate fails; failure is shown; stays armed for a retry', async () => {
    const runShip = vi.fn();
    const { deps, rounds, log } = rig({ runGates: async () => 'typecheck failed', runShip });
    await autoDeliverAfterConflict(deps);
    expect(runShip).not.toHaveBeenCalled();
    expect(log.some((l) => l.startsWith('error:') && l.includes('typecheck failed'))).toBe(true);
    expect(rounds.armed(1)).not.toBeNull();
  });

  it('blocked sync (unknown CLI) pushes nothing and surfaces the reason', async () => {
    const blocked = vi.fn(async () => undefined);
    const runShip = vi.fn();
    const { deps } = rig({
      ensureSynced: async () => ({ ok: false, reason: 'sbx CLI not runnable from the extension host: ENOENT', diverged: false, unknown: true }),
      blocked,
      runShip,
    });
    await autoDeliverAfterConflict(deps);
    expect(blocked).toHaveBeenCalledWith('sbx CLI not runnable from the extension host: ENOENT', false, true);
    expect(runShip).not.toHaveBeenCalled();
  });

  it('two concurrent idle hooks push once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const runShip = vi.fn(async () => { await gate; });
    const { deps } = rig({ runShip });
    const a = autoDeliverAfterConflict(deps);
    const b = autoDeliverAfterConflict(deps);
    release();
    await Promise.all([a, b]);
    expect(runShip).toHaveBeenCalledTimes(1);
  });

  it('a ship run in flight skips quietly', async () => {
    const runShip = vi.fn();
    const { deps, log } = rig({ targets: () => ({ available: false, reason: 'in-flight' }), runShip });
    await autoDeliverAfterConflict(deps);
    expect(runShip).not.toHaveBeenCalled();
    expect(log.some((l) => l.includes('error:Deliver to PR: another ship run'))).toBe(false);
  });
});

describe('verifyMergeResolved', () => {
  const git = (map: Record<string, { code: number; stdout: string }>) => async (_cwd: string, args: readonly string[]) =>
    map[args.join(' ')] ?? { code: 0, stdout: '' };

  it('passes when base is an ancestor, tree clean, no markers', async () => {
    expect(await verifyMergeResolved(git({}), '/wt', ROUND)).toBeNull();
  });
  it('fails when the branch lacks the base head', async () => {
    const r = await verifyMergeResolved(git({ 'merge-base --is-ancestor b4se HEAD': { code: 1, stdout: '' } }), '/wt', ROUND);
    expect(r).toMatch(/does not contain the base/);
  });
  it('fails on a dirty tree', async () => {
    const r = await verifyMergeResolved(git({ 'status --porcelain': { code: 0, stdout: ' M a.ts\n' } }), '/wt', ROUND);
    expect(r).toMatch(/uncommitted/);
  });
  it('reports the short base sha, the status failure and each marker file', async () => {
    const sha = '0123456789abcdef';
    expect(await verifyMergeResolved(git({ [`merge-base --is-ancestor ${sha} HEAD`]: { code: 1, stdout: '' } }), '/wt', { ...ROUND, baseSha: sha })).toBe('the branch does not contain the base head 012345678 yet');
    expect(await verifyMergeResolved(git({ 'status --porcelain': { code: 128, stdout: '' } }), '/wt', ROUND)).toBe('could not read the worktree status');
    const two = { ...ROUND, files: ['a.ts', 'b.ts'] };
    expect(await verifyMergeResolved(git({ 'grep -lE ^(<<<<<<< |>>>>>>> ) HEAD -- a.ts b.ts': { code: 0, stdout: 'HEAD:a.ts\nHEAD:b.ts\n' } }), '/wt', two)).toBe('conflict markers remain in a.ts, b.ts');
  });
  it('skips the ancestor check when no base sha was recorded and the marker scan when no files', async () => {
    const calls: string[] = [];
    const g = async (_c: string, a: readonly string[]) => { calls.push(a[0]!); return { code: 0, stdout: '' }; };
    expect(await verifyMergeResolved(g, '/wt', { repo: 'r', baseSha: null, files: [] })).toBeNull();
    expect(calls).toEqual(['status']);
  });
  it('ignores a grep hit with empty output and a failing grep', async () => {
    expect(await verifyMergeResolved(git({ 'grep -lE ^(<<<<<<< |>>>>>>> ) HEAD -- a.ts': { code: 0, stdout: '\n' } }), '/wt', ROUND)).toBeNull();
    expect(await verifyMergeResolved(git({ 'grep -lE ^(<<<<<<< |>>>>>>> ) HEAD -- a.ts': { code: 1, stdout: 'HEAD:a.ts' } }), '/wt', ROUND)).toBeNull();
  });
  it('fails on conflict markers in a conflicted file', async () => {
    const r = await verifyMergeResolved(git({ 'grep -lE ^(<<<<<<< |>>>>>>> ) HEAD -- a.ts': { code: 0, stdout: 'HEAD:a.ts\n' } }), '/wt', ROUND);
    expect(r).toMatch(/conflict markers.*a\.ts/);
  });
});

describe('armConflictRound', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());
  const seed = (stage: string, state: 'conflicted' | 'clean') => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, t.id);
    setMergeCheck(store, { ticketId: t.id, repo: 'api', state, files: ['a.ts'], reason: null, headSha: 'h', baseSha: 'b4se', baseRef: 'main', checkedAt: '2026-10-23T00:00:00.000Z' });
    return t.id;
  };
  it('arms a conflicted repo at ship with the recorded base sha and files', () => {
    const id = seed('ship', 'conflicted');
    const rounds = createConflictRounds();
    armConflictRound(store, rounds, id, 'api');
    expect(rounds.armed(id)).toEqual({ repo: 'api', baseSha: 'b4se', files: ['a.ts'] });
  });
  it('does not arm outside ship (impl/fix end by marker)', () => {
    const id = seed('impl', 'conflicted');
    const rounds = createConflictRounds();
    armConflictRound(store, rounds, id, 'api');
    expect(rounds.armed(id)).toBeNull();
  });
  it('does not arm a repo that is not conflicted', () => {
    const id = seed('ship', 'clean');
    const rounds = createConflictRounds();
    armConflictRound(store, rounds, id, 'api');
    expect(rounds.armed(id)).toBeNull();
  });
});
