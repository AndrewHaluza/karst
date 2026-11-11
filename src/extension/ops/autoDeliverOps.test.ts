import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import {
  armConflictRound,
  autoDeliverAfterConflict,
  isAutoDelivering,
  takeOverAutoDeliver,
  deliverTakeOverNote,
  autoDeliverPhase,
  isConflictRoundStalled,
  CONFLICT_ROUND_STALL_MS,
  createConflictRounds,
  verifyMergeResolved,
  type AutoDeliverDeps,
  type ResolvedRound,
  rerunSkippedGates,
  beginManualPush,
  deliverRerunNote,
  type RerunDeps,
  type RerunResult,
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
    expect(verified).toEqual(['/wt', '/wt']);
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

  it('pushes nothing when the tree changes while the gates run', async () => {
    let calls = 0;
    const { deps, log } = rig({ verifyMerge: async () => (++calls === 2 ? 'the worktree has uncommitted changes' : null) });
    await autoDeliverAfterConflict(deps);
    expect(log).not.toContain('ship');
    expect(log).toContain('error:conflict resolve did not finish: the worktree has uncommitted changes');
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
  it('a grep error is not read as no markers', async () => {
    expect(await verifyMergeResolved(git({ 'grep -lE ^(<<<<<<< |>>>>>>> ) HEAD -- a.ts': { code: 128, stdout: '' } }), '/wt', ROUND)).toBe('could not scan the resolved files for conflict markers');
  });
  it('ignores a grep hit with empty output and a no-match grep', async () => {
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

describe('isAutoDelivering', () => {
  it('is true only while the auto-deliver of the ticket runs', async () => {
    const seen: boolean[] = [];
    const { deps } = rig({ verifyMerge: async () => { seen.push(isAutoDelivering(1)); return 'stop'; } });
    expect(isAutoDelivering(1)).toBe(false);
    await autoDeliverAfterConflict(deps);
    expect(seen[0]).toBe(true);
    expect(isAutoDelivering(1)).toBe(false);
  });
});

describe('isConflictRoundStalled', () => {
  it('is true only for a round armed longer than the stall time with no delivery running', () => {
    const rounds = createConflictRounds();
    expect(isConflictRoundStalled(rounds, 9)).toBe(false);
    rounds.arm(9, ROUND);
    const at = rounds.armedAt(9)!;
    expect(isConflictRoundStalled(rounds, 9, at + CONFLICT_ROUND_STALL_MS)).toBe(false);
    expect(isConflictRoundStalled(rounds, 9, at + CONFLICT_ROUND_STALL_MS + 1)).toBe(true);
    rounds.disarm(9);
    expect(rounds.armedAt(9)).toBeNull();
  });
});

describe('manual Deliver takes over an in-flight auto-deliver (T1018)', () => {
  const taken = { failed: ['unit'], skipped: ['visual', 'docs'] };

  it('aborts the gate run, disarms the round, writes one note, and the auto-deliver never pushes', async () => {
    let seenSignal: AbortSignal | undefined;
    let release!: (v: string | null) => void;
    const { deps, rounds, log } = rig({
      runGates: (_prs, signal) => { seenSignal = signal; return new Promise((r) => { release = r; signal.addEventListener('abort', () => r('r: gate run was stopped')); }); },
    });
    const auto = autoDeliverAfterConflict(deps);
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    expect(autoDeliverPhase(1)).toBe('gates');
    const notes: Array<[string, string]> = [];
    const result = takeOverAutoDeliver(1, { rounds, recordTakeOver: () => taken, note: (t, b) => notes.push([t, b]), key: 'T1' });
    expect(result).toBe('taken-over');
    expect(seenSignal?.aborted).toBe(true);
    expect(rounds.armed(1)).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0]![0]).toBe('Autopilot: delivery taken over by a manual Deliver; failed: unit; skipped: visual, docs');
    await auto;
    release(null);
    expect(log.filter((l) => l === 'ship')).toHaveLength(0);
    expect(log.some((l) => l.startsWith('error:'))).toBe(false);
    expect(isAutoDelivering(1)).toBe(false);
  });

  it('a takeover during the final merge check stops the auto-deliver from pushing', async () => {
    let calls = 0;
    let rounds!: ReturnType<typeof rig>['rounds'];
    const notes: string[] = [];
    const r = rig({
      verifyMerge: async () => {
        if (++calls === 2) takeOverAutoDeliver(1, { rounds, recordTakeOver: () => taken, note: (t) => notes.push(t), key: 'T1' });
        return null;
      },
    });
    rounds = r.rounds;
    await autoDeliverAfterConflict(r.deps);
    expect(r.log).not.toContain('ship');
    expect(r.log.some((l) => l.startsWith('error:'))).toBe(false);
    expect(notes).toHaveLength(1);
    expect(isAutoDelivering(1)).toBe(false);
  });

  it('names none when no gate failed or was skipped', () => {
    const notes: string[] = [];
    const { rounds } = rig();
    // not in flight: nothing is taken over and nothing is written
    expect(takeOverAutoDeliver(1, { rounds, recordTakeOver: () => ({ failed: [], skipped: [] }), note: (t) => notes.push(t), key: 'T1' })).toBe('none');
    expect(notes).toEqual([]);
    expect(rounds.armed(1)).not.toBeNull();
  });

  it('does not take over once the auto-deliver pushes', async () => {
    let result: ReturnType<typeof takeOverAutoDeliver> | undefined;
    const { deps, rounds } = rig();
    const notes: string[] = [];
    const run = { ...deps, runShip: async () => { result = takeOverAutoDeliver(1, { rounds, recordTakeOver: () => taken, note: (t) => notes.push(t), key: 'T1' }); } };
    await autoDeliverAfterConflict(run);
    expect(result).toBe('pushing');
    expect(notes).toEqual([]);
  });

  it('words the note with none for empty lists', () => {
    expect(deliverTakeOverNote({ failed: [], skipped: [] })).toBe('Autopilot: delivery taken over by a manual Deliver; failed: none; skipped: none');
  });
});

function rerigRerun(over: Partial<RerunDeps> = {}) {
  const calls: Array<{ gates: readonly string[]; signal: AbortSignal }> = [];
  const log: string[] = [];
  const notes: Array<[string, string]> = [];
  const deps: RerunDeps = {
    ticketId: 5,
    key: 'T5',
    skipped: ['integration', 'visual'],
    agentActive: () => false,
    runGates: async (gates, signal): Promise<RerunResult> => { calls.push({ gates, signal }); return { kind: 'passed', headSha: 'abcdef1234567890' }; },
    note: (t, b) => notes.push([t, b]),
    log: (m) => log.push(m),
    ...over,
  };
  return { deps, calls, log, notes };
}

describe('rerunSkippedGates (after a manual Deliver took over)', () => {
  it('runs exactly the skipped gates and writes one passed note', async () => {
    const { deps, calls, notes } = rerigRerun();
    expect(await rerunSkippedGates(deps)).toBe('passed');
    expect(calls.map((c) => c.gates)).toEqual([['integration', 'visual']]);
    expect(notes).toHaveLength(1);
    expect(notes[0]![0]).toBe('Autopilot: the gates skipped by the manual Deliver ran on abcdef123: passed');
  });

  it('names the failed gates in the note', async () => {
    const { deps, notes } = rerigRerun({ runGates: async () => ({ kind: 'failed', headSha: 'abcdef1234567890', failed: ['visual'] }) });
    expect(await rerunSkippedGates(deps)).toBe('failed');
    expect(notes.map((n) => n[0])).toEqual(['Autopilot: the gates skipped by the manual Deliver ran on abcdef123: failed: visual']);
  });

  it('runs nothing when no gate was skipped', async () => {
    const { deps, calls, notes } = rerigRerun({ skipped: [] });
    expect(await rerunSkippedGates(deps)).toBe('nothing');
    expect(calls).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });

  it('refuses while an agent turn is active and says so in the log', async () => {
    const { deps, calls, log, notes } = rerigRerun({ agentActive: () => true });
    expect(await rerunSkippedGates(deps)).toBe('refused');
    expect(calls).toHaveLength(0);
    expect(log.join('\n')).toMatch(/not started: an agent turn is active/);
    expect(notes).toHaveLength(0);
  });

  it('refuses while a push is in flight and says so in the log', async () => {
    const { deps, calls, log } = rerigRerun();
    const endPush = beginManualPush(5);
    expect(await rerunSkippedGates(deps)).toBe('refused');
    expect(log.join('\n')).toMatch(/not started: a push is in flight/);
    endPush();
    expect(await rerunSkippedGates(deps)).toBe('passed');
    expect(calls).toHaveLength(1);
  });

  it('refuses a second re-run of the same ticket while the first runs', async () => {
    let release!: (r: RerunResult) => void;
    const first = rerigRerun({ runGates: () => new Promise<RerunResult>((r) => { release = r; }) });
    const running = rerunSkippedGates(first.deps);
    const second = rerigRerun();
    expect(await rerunSkippedGates(second.deps)).toBe('refused');
    release({ kind: 'passed', headSha: 'abcdef1234567890' });
    expect(await running).toBe('passed');
  });

  it('a newer push aborts the re-run and records it as superseded, not failed', async () => {
    let signal!: AbortSignal;
    let release!: (r: RerunResult) => void;
    const { deps, notes } = rerigRerun({ runGates: (_g, s) => { signal = s; return new Promise<RerunResult>((r) => { release = r; }); } });
    const running = rerunSkippedGates(deps);
    const endPush = beginManualPush(5);
    expect(signal.aborted).toBe(true);
    release({ kind: 'stopped', headSha: 'abcdef1234567890' });
    expect(await running).toBe('superseded');
    endPush();
    expect(notes.map((n) => n[0])).toEqual(['Autopilot: the gates skipped by the manual Deliver ran on abcdef123: superseded by a newer push']);
  });

  it('a stop that no push caused is not a supersede', async () => {
    const { deps } = rerigRerun({ runGates: async () => ({ kind: 'stopped', headSha: null }) });
    expect(await rerunSkippedGates(deps)).toBe('stopped');
  });

  it('words the note for an unknown head', () => {
    expect(deliverRerunNote({ kind: 'passed', headSha: null })).toBe('Autopilot: the gates skipped by the manual Deliver ran on unknown head: passed');
  });

  it('writes the note body with the key and no Autopilot prefix, and logs the outcome', async () => {
    const { deps, notes, log } = rerigRerun();
    await rerunSkippedGates(deps);
    expect(notes[0]![1]).toBe('T5: the gates skipped by the manual Deliver ran on abcdef123: passed. A failure stays on record on the ship panel.');
    expect(log).toContain('[ship] ticket T5 skipped-gate re-run: passed');
  });

  it('a stop that no push caused writes no note and words the stopped line', async () => {
    const { deps, notes } = rerigRerun({ runGates: async () => ({ kind: 'stopped', headSha: 'abcdef1234567890' }) });
    expect(await rerunSkippedGates(deps)).toBe('stopped');
    expect(notes).toHaveLength(0);
    expect(deliverRerunNote({ kind: 'stopped', headSha: 'abcdef1234567890' })).toBe('Autopilot: the gates skipped by the manual Deliver ran on abcdef123: stopped');
  });

  it('words the refusal of a second re-run in the log', async () => {
    let release!: (r: RerunResult) => void;
    const first = rerigRerun({ runGates: () => new Promise<RerunResult>((r) => { release = r; }) });
    const running = rerunSkippedGates(first.deps);
    const second = rerigRerun();
    await rerunSkippedGates(second.deps);
    expect(second.log).toEqual(['[ship] ticket T5 skipped-gate re-run not started: a re-run is already in progress']);
    release({ kind: 'passed', headSha: null });
    await running;
  });

  it('keeps refusing until every overlapping push ended, and an end called twice counts once', async () => {
    const { deps } = rerigRerun();
    const endA = beginManualPush(5);
    const endB = beginManualPush(5);
    endA();
    endA();
    expect(await rerunSkippedGates(deps)).toBe('refused');
    endB();
    expect(await rerunSkippedGates(deps)).toBe('passed');
  });

  it('a push of another ticket neither blocks nor aborts the re-run', async () => {
    const { deps } = rerigRerun();
    const end = beginManualPush(99);
    expect(await rerunSkippedGates(deps)).toBe('passed');
    end();
  });

  it('a push that begins after the re-run ended does not mark it superseded', async () => {
    const { deps } = rerigRerun();
    await rerunSkippedGates(deps);
    beginManualPush(5)();
    expect(await rerunSkippedGates(deps)).toBe('passed');
  });
});
