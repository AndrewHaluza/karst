import { describe, expect, it, vi } from 'vitest';
import {
  countUndelivered,
  createUndeliveredTracker,
  deliverToPr,
  refreshUndelivered,
  type CountDeps,
  type DeliverDeps,
} from './deliverToPrOps.js';
import type { DeliverPr, DeliverTargets } from '../../workflow/deliverState.js';

const PR: DeliverPr = { repo: 'karst', number: 7, branch: 'feat/x', cwd: '/wt' };
const OPEN: DeliverTargets = { available: true, prs: [PR] };

function countRig(host: string, sandbox: string | null, sandboxCount = '0') {
  const calls: string[] = [];
  const deps: CountDeps = {
    git: async (_cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-list') return { code: 0, stdout: `${args[2]!.startsWith('origin/') ? host : sandboxCount}\n` };
      return { code: 0, stdout: '' };
    },
    sandboxRef: async () => sandbox,
  };
  return { deps, calls };
}

describe('countUndelivered', () => {
  it('none: both zero', async () => {
    expect(await countUndelivered(countRig('0', null).deps, PR)).toEqual({ hostAhead: 0, sandboxAhead: 0 });
  });
  it('worktree-only', async () => {
    expect(await countUndelivered(countRig('2', null).deps, PR)).toEqual({ hostAhead: 2, sandboxAhead: 0 });
  });
  it('sandbox-only', async () => {
    expect(await countUndelivered(countRig('0', 'FETCH_HEAD', '3').deps, PR)).toEqual({ hostAhead: 0, sandboxAhead: 3 });
  });
  it('both', async () => {
    const { deps, calls } = countRig('1', 'FETCH_HEAD', '3');
    expect(await countUndelivered(deps, PR)).toEqual({ hostAhead: 1, sandboxAhead: 3 });
    expect(calls).toContain('rev-list --count HEAD..FETCH_HEAD');
    expect(calls).toContain('fetch --no-write-fetch-head origin feat/x');
    expect(calls).toContain('rev-list --count origin/feat/x..HEAD');
  });
  it('a failed git read counts as zero', async () => {
    const deps: CountDeps = { git: async () => ({ code: 1, stdout: '' }), sandboxRef: async () => 'FETCH_HEAD' };
    expect(await countUndelivered(deps, PR)).toEqual({ hostAhead: 0, sandboxAhead: 0 });
  });
});

describe('refreshUndelivered / tracker', () => {
  it('stores the sum over repos and clears at zero', async () => {
    const tracker = createUndeliveredTracker();
    const two: DeliverTargets = { available: true, prs: [PR, { ...PR, repo: 'b', cwd: '/b' }] };
    await refreshUndelivered(tracker, 1, two, countRig('1', 'FETCH_HEAD', '2').deps);
    expect(tracker.get(1)).toEqual({ hostAhead: 2, sandboxAhead: 4 });
    await refreshUndelivered(tracker, 1, OPEN, countRig('0', null).deps);
    expect(tracker.get(1)).toBeUndefined();
  });
  it('clears when the ticket has no deliverable PR, without touching git', async () => {
    const tracker = createUndeliveredTracker();
    tracker.set(1, { hostAhead: 1, sandboxAhead: 0 });
    const git = vi.fn();
    await refreshUndelivered(tracker, 1, { available: false, reason: 'stage' }, { git, sandboxRef: async () => null });
    expect(tracker.get(1)).toBeUndefined();
    expect(git).not.toHaveBeenCalled();
  });
});

function deliverRig(over: Partial<DeliverDeps> = {}) {
  const calls: string[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const deps: DeliverDeps = {
    targets: () => OPEN,
    agentActive: () => false,
    ensureSynced: async () => { calls.push('sync'); return { ok: true }; },
    blocked: async (reason, rewritten, cliUnknown) => { calls.push(`blocked:${reason}:${rewritten}${cliUnknown ? ':cli' : ''}`); },
    runShip: async () => { calls.push('ship'); },
    reprobe: async () => { calls.push('reprobe'); },
    info: (m) => infos.push(m),
    error: (m) => errors.push(m),
    logError: vi.fn(),
    afterServerChange: vi.fn(),
    ...over,
  };
  return { deps, calls, errors, infos };
}

describe('deliverToPr', () => {
  it('syncs, pushes through ship, then re-probes — in that order', async () => {
    const r = deliverRig();
    await deliverToPr(r.deps);
    expect(r.calls).toEqual(['sync', 'ship', 'reprobe']);
    expect(r.deps.afterServerChange).toHaveBeenCalled();
  });
  it('refuses while an agent turn is active', async () => {
    const r = deliverRig({ agentActive: () => true });
    await deliverToPr(r.deps);
    expect(r.calls).toEqual([]);
    expect(r.errors).toEqual(['Deliver to PR: agent is working; try when idle.']);
  });
  it('refuses while another ship run is in flight', async () => {
    const r = deliverRig({ targets: () => ({ available: false, reason: 'in-flight' }) });
    await deliverToPr(r.deps);
    expect(r.calls).toEqual([]);
    expect(r.errors[0]).toMatch(/in flight/);
  });
  it('says so when there is no open PR', async () => {
    const r = deliverRig({ targets: () => ({ available: false, reason: 'no-open-pr' }) });
    await deliverToPr(r.deps);
    expect(r.calls).toEqual([]);
    expect(r.infos[0]).toMatch(/not available/);
  });
  it('a diverged clone stops before the push and raises the blocker', async () => {
    const r = deliverRig({ ensureSynced: async () => ({ ok: false, reason: 'not a fast-forward', diverged: true, rewritten: true }) });
    await deliverToPr(r.deps);
    expect(r.calls).toEqual(['blocked:not a fast-forward:true']);
  });
  it('an unknown sandbox CLI stops before the push and flags the blocker as a PATH problem', async () => {
    const r = deliverRig({ ensureSynced: async () => ({ ok: false, reason: 'sbx CLI not runnable', diverged: false, unknown: true }) });
    await deliverToPr(r.deps);
    expect(r.calls).toEqual(['blocked:sbx CLI not runnable:false:cli']);
  });
  it('an agent turn that starts during the sync stops before the push', async () => {
    let active = false;
    const r = deliverRig({ agentActive: () => active, ensureSynced: async () => { active = true; return { ok: true }; } });
    await deliverToPr(r.deps);
    expect(r.calls).toEqual([]);
    expect(r.errors[0]).toMatch(/agent is working/);
  });
  it('a failed ship push is reported and skips the re-probe', async () => {
    const r = deliverRig({ runShip: async () => { throw new Error('push rejected'); } });
    await deliverToPr(r.deps);
    expect(r.calls).toEqual(['sync']);
    expect(r.errors).toEqual(['Deliver to PR failed: push rejected']);
  });
});

describe('deliverToPr verify step', () => {
  const base = (over: Partial<DeliverDeps>): DeliverDeps => ({
    targets: () => OPEN,
    agentActive: () => false,
    ensureSynced: async () => ({ ok: true }),
    blocked: async () => undefined,
    runShip: async () => undefined,
    reprobe: async () => undefined,
    info: () => undefined,
    error: () => undefined,
    logError: () => undefined,
    afterServerChange: () => undefined,
    ...over,
  });
  it('a verify reason stops before the push and is returned', async () => {
    const runShip = vi.fn();
    const out = await deliverToPr(base({ verify: async () => 'nope', runShip }));
    expect(runShip).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: 'refused', reason: 'nope' });
  });
  it('delivered outcome after a push', async () => {
    expect(await deliverToPr(base({ verify: async () => null }))).toEqual({ kind: 'delivered' });
  });
  it('blocked sync outcome', async () => {
    const out = await deliverToPr(base({ ensureSynced: async () => ({ ok: false, reason: 'x', diverged: false }) }));
    expect(out).toEqual({ kind: 'blocked', reason: 'x' });
  });
});
