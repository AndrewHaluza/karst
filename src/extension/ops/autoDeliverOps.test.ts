import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrain } from '../../runtime/drain.js';
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
  shipGateFailureTail,
  type AutoDeliverDeps,
  type ResolvedRound,
  rerunSkippedGates,
  beginManualPush,
  supersedeRerun,
  deliverRerunNote,
  type RerunDeps,
  type RerunResult,
  setDeliverDrain,
  liveDeliverTickets,
  conflictRoundEnded,
  endConflictRoundOnDeliver,
} from './autoDeliverOps.js';
import type { DeliverTargets } from '../../workflow/deliverState.js';
import type { ShipGateReport } from './shipGatesOps.js';

const OPEN: DeliverTargets = { available: true, prs: [{ repo: 'karst', number: 7, branch: 'feat/x', cwd: '/wt' }] };
const ROUND: ResolvedRound = { repo: 'karst', baseSha: 'b4se', files: ['a.ts'] };

/** A failed ship gate run: every gate named here failed, on the round's repo. */
const failedRun = (...gates: Array<[string, string]>): ShipGateReport => ({
  reason: 'r: gate failed', failed: gates.map(([name, output]) => ({ name, repo: 'karst', output })),
});

function rig(over: Partial<AutoDeliverDeps> = {}) {
  const rounds = createConflictRounds();
  rounds.arm(1, ROUND);
  const log: string[] = [];
  const deps: AutoDeliverDeps = {
    store: openStore(':memory:'),
    ticketId: 1,
    key: 'T1',
    rounds,
    targets: () => OPEN,
    agentActive: () => false,
    ensureSynced: async () => ({ ok: true }),
    verifyMerge: async () => null,
    runGates: async () => ({ reason: null, failed: [] }),
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
  it('does not push when the merge with the moved base fails, and shows the CI reason (D541)', async () => {
    const { deps, rounds, log } = rig({ checkBase: async () => 'fails when merged with origin/develop abc; CI tests this merge' });
    await autoDeliverAfterConflict(deps);
    expect(log).not.toContain('ship');
    expect(log.some((l) => l.startsWith('error:') && l.includes('CI tests this merge'))).toBe(true);
    expect(rounds.armed(1)).not.toBeNull();
  });

  it('pushes when the merge with the moved base passes, and the check runs after the ship gates (D541)', async () => {
    const order: string[] = [];
    const { deps, log } = rig({
      runGates: async () => { order.push('gates'); return { reason: null, failed: [] }; },
      checkBase: async () => { order.push('base'); return null; },
    });
    await autoDeliverAfterConflict(deps);
    expect(order).toEqual(['gates', 'base']);
    expect(log).toContain('ship');
  });

  it('does not run the base check when a ship gate failed (D541)', async () => {
    let checked = false;
    const { deps } = rig({ runGates: async () => ({ reason: 'r: gate "test" failed', failed: [] }), checkBase: async () => { checked = true; return null; } });
    await autoDeliverAfterConflict(deps);
    expect(checked).toBe(false);
  });

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
      runGates: async (all) => { gated = all.length; return { reason: null, failed: [] }; },
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
    const { deps, rounds, log } = rig({ runGates: async () => ({ reason: 'typecheck failed', failed: [] }), runShip });
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

describe('isConflictRoundStalled (the stall clock starts at the receipt, @arch:AP-01)', () => {
  const T0 = Date.parse('2026-11-17T20:00:00.000Z');
  const receipt = (iso: string | null) => (_repo: string) => iso;

  it('is false with no round', () => {
    expect(isConflictRoundStalled(createConflictRounds(), 9, receipt('2026-11-17T20:00:00.000Z'), T0 + 10 * CONFLICT_ROUND_STALL_MS)).toBe(false);
  });

  it('is false for a round with no receipt, however old it is: the sweep owns it', () => {
    const rounds = createConflictRounds();
    rounds.arm(9, ROUND);
    expect(isConflictRoundStalled(rounds, 9, receipt(null), Date.now() + 100 * CONFLICT_ROUND_STALL_MS)).toBe(false);
  });

  it('is true only after the stall time past the receipt, with no delivery running', () => {
    const rounds = createConflictRounds();
    rounds.arm(9, ROUND);
    const read = receipt('2026-11-17T20:00:00.000Z');
    expect(isConflictRoundStalled(rounds, 9, read, T0 + CONFLICT_ROUND_STALL_MS)).toBe(false);
    expect(isConflictRoundStalled(rounds, 9, read, T0 + CONFLICT_ROUND_STALL_MS + 1)).toBe(true);
  });

  it('reads the receipt of the repo of the round', () => {
    const rounds = createConflictRounds();
    rounds.arm(9, ROUND);
    const asked: string[] = [];
    isConflictRoundStalled(rounds, 9, (repo) => { asked.push(repo); return null; });
    expect(asked).toEqual([ROUND.repo]);
  });

  it('does not stall a round whose wait passed asleep (T1326)', () => {
    const rounds = createConflictRounds();
    rounds.arm(9, ROUND);
    const read = receipt('2026-11-17T20:00:00.000Z');
    const slept = 2 * 60 * 60_000;
    const awakeAfterTwoHours = (sinceMs: number, nowMs: number): number =>
      Math.max(0, nowMs - sinceMs - slept);
    // Wall 2 h, all of it asleep: not stalled.
    expect(isConflictRoundStalled(rounds, 9, read, T0 + slept + 60_000, awakeAfterTwoHours)).toBe(false);
    // The same sleep, with the stall window actually spent awake: still stalled.
    expect(
      isConflictRoundStalled(rounds, 9, read, T0 + slept + CONFLICT_ROUND_STALL_MS + 1, awakeAfterTwoHours),
    ).toBe(true);
  });

  it('does not stall a round while its resolved merge is being delivered', async () => {
    const seen: boolean[] = [];
    const { deps, rounds } = rig({
      runGates: async () => {
        seen.push(isConflictRoundStalled(rounds, 1, receipt('2026-11-17T20:00:00.000Z'), T0 + CONFLICT_ROUND_STALL_MS * 3));
        return { reason: null, failed: [] };
      },
    });
    expect(isConflictRoundStalled(rounds, 1, receipt('2026-11-17T20:00:00.000Z'), T0 + CONFLICT_ROUND_STALL_MS * 3)).toBe(true);
    await autoDeliverAfterConflict(deps);
    expect(seen).toEqual([false]);
  });

  // T1315: the gates of a delivery can run longer than the stall time. The clock counts from the end of that delivery.
  it('starts the clock at the end of the last delivery, not at the receipt', () => {
    const rounds = createConflictRounds();
    rounds.arm(9, ROUND);
    const oldReceipt = receipt(new Date(Date.now() - 25 * 60_000).toISOString());
    expect(isConflictRoundStalled(rounds, 9, oldReceipt, Date.now())).toBe(true);
    rounds.markDelivered(9);
    expect(isConflictRoundStalled(rounds, 9, oldReceipt, Date.now() + 300)).toBe(false);
    expect(isConflictRoundStalled(rounds, 9, oldReceipt, Date.now() + CONFLICT_ROUND_STALL_MS + 1)).toBe(true);
  });

  it('a new round forgets the delivery end and the refusal of the round before it', () => {
    const rounds = createConflictRounds();
    expect(rounds.armedAt(9)).toBeNull();
    rounds.arm(9, ROUND);
    expect(rounds.armedAt(9)).toEqual(expect.any(Number));
    rounds.markDelivered(9);
    rounds.refuse(9, { repo: ROUND.repo, tail: 'gate "unit" failed', sha: null, runId: null, baseRef: null, baseSha: ROUND.baseSha });
    expect(rounds.deliveredAt(9)).not.toBeNull();
    rounds.arm(9, ROUND);
    expect(rounds.deliveredAt(9)).toBeNull();
    expect(rounds.refusal(9)).toBeNull();
  });

  it('a disarm drops the round and everything recorded with it', () => {
    const rounds = createConflictRounds();
    rounds.arm(9, ROUND);
    rounds.markDelivered(9);
    rounds.refuse(9, { repo: ROUND.repo, tail: 'the base check failed', sha: 'abc', runId: null, baseRef: null, baseSha: ROUND.baseSha });
    rounds.disarm(9);
    expect(rounds.armed(9)).toBeNull();
    expect(rounds.armedAt(9)).toBeNull();
    expect(rounds.deliveredAt(9)).toBeNull();
    expect(rounds.refusal(9)).toBeNull();
  });

  it('is false for a receipt that is not a date', () => {
    const rounds = createConflictRounds();
    rounds.arm(9, ROUND);
    expect(isConflictRoundStalled(rounds, 9, receipt('not a date'), Date.now() + CONFLICT_ROUND_STALL_MS * 10)).toBe(false);
  });

  it('records the end of the auto-deliver on the round, so a refused push is not stalled in the same tick', async () => {
    const { deps, rounds } = rig({
      runGates: async () => ({ reason: 'r: gate "unit" failed', failed: [{ name: 'unit', repo: 'karst', output: 'AssertionError' }] }),
    });
    await autoDeliverAfterConflict(deps);
    expect(rounds.deliveredAt(1)).not.toBeNull();
    expect(isConflictRoundStalled(rounds, 1, receipt(new Date(Date.now() - CONFLICT_ROUND_STALL_MS * 5).toISOString()), Date.now() + 300)).toBe(false);
  });
});

describe('manual Deliver takes over an in-flight auto-deliver (T1018)', () => {
  const taken = { failed: ['unit'], skipped: ['visual', 'docs'] };

  it('aborts the gate run, disarms the round, writes one note, and the auto-deliver never pushes', async () => {
    let seenSignal: AbortSignal | undefined;
    let release!: (v: { reason: string | null; failed: never[] }) => void;
    const { deps, rounds, log } = rig({
      runGates: (_prs, signal) => { seenSignal = signal; return new Promise((r) => { release = r; signal.addEventListener('abort', () => r({ reason: 'r: gate run was stopped', failed: [] })); }); },
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
    release({ reason: null, failed: [] });
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
    const ended = supersedeRerun(5);
    expect(signal.aborted).toBe(true);
    release({ kind: 'stopped', headSha: 'abcdef1234567890' });
    expect(await running).toBe('superseded');
    await ended;
    expect(notes.map((n) => n[0])).toEqual(['Autopilot: the gates skipped by the manual Deliver ran on abcdef123: superseded by a newer push']);
  });

  it('a push that is only in flight does not abort the re-run: a click that pushes nothing leaves it alone', async () => {
    let signal!: AbortSignal;
    let release!: (r: RerunResult) => void;
    const { deps } = rerigRerun({ runGates: (_g, s) => { signal = s; return new Promise<RerunResult>((r) => { release = r; }); } });
    const running = rerunSkippedGates(deps);
    const endPush = beginManualPush(5);
    expect(signal.aborted).toBe(false);
    endPush();
    release({ kind: 'passed', headSha: null });
    expect(await running).toBe('passed');
  });

  it('supersedeRerun resolves at once when no re-run runs, and when it ended', async () => {
    await expect(supersedeRerun(5)).resolves.toBeUndefined();
  });

  it('reports the refusal reason to the user through refused', async () => {
    const reasons: string[] = [];
    const { deps } = rerigRerun({ agentActive: () => true, refused: (w) => reasons.push(w) });
    expect(await rerunSkippedGates(deps)).toBe('refused');
    expect(reasons).toEqual(['an agent turn is active']);
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

  it('a stop that no push caused writes a note and words the stopped line', async () => {
    const { deps, notes } = rerigRerun({ runGates: async () => ({ kind: 'stopped', headSha: 'abcdef1234567890' }) });
    expect(await rerunSkippedGates(deps)).toBe('stopped');
    expect(notes).toHaveLength(1);
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

  it('an auto-deliver that starts aborts a running re-run and records it superseded', async () => {
    let signalOf!: AbortSignal;
    let release!: (r: RerunResult) => void;
    const re = rerigRerun({ ticketId: 1, key: 'T1', runGates: (_g, s) => new Promise<RerunResult>((r) => { signalOf = s; release = r; }) });
    const running = rerunSkippedGates(re.deps);
    let started = false;
    const { deps } = rig({ runGates: async () => { started = true; return { reason: null, failed: [] }; } });
    const auto = autoDeliverAfterConflict(deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(signalOf.aborted).toBe(true);
    // The auto-deliver waits until the older re-run unwound: its gates and run row come after the stale run closed.
    expect(started).toBe(false);
    release({ kind: 'stopped', headSha: 'abcdef1234567890' });
    expect(await running).toBe('superseded');
    await auto;
    expect(started).toBe(true);
  });

  it('refuses a re-run while an auto-deliver runs its gates, and logs why', async () => {
    let hold!: () => void;
    const gates = new Promise<{ reason: null; failed: never[] }>((r) => { hold = () => r({ reason: null, failed: [] }); });
    const { deps } = rig({ runGates: () => gates });
    const auto = autoDeliverAfterConflict(deps);
    const re = rerigRerun({ ticketId: 1, key: 'T1' });
    expect(await rerunSkippedGates(re.deps)).toBe('refused');
    expect(re.log).toEqual(['[ship] ticket T1 skipped-gate re-run not started: an auto-deliver is running']);
    expect(re.calls).toHaveLength(0);
    hold();
    await auto;
  });
});

describe('the drain (@arch:DRAIN-01)', () => {
  afterEach(() => setDeliverDrain(undefined));

  it('starts no auto-deliver while draining, leaves the round armed and logs the reason', async () => {
    setDeliverDrain(() => true);
    const { deps, rounds, log } = rig();
    const runGates = vi.fn(async () => ({ reason: null, failed: [] }));
    await autoDeliverAfterConflict({ ...deps, runGates });
    expect(runGates).not.toHaveBeenCalled();
    expect(rounds.armed(1)).not.toBeNull();
    expect(log.some((l) => l.includes('not started: draining'))).toBe(true);
  });

  it('starts the auto-deliver again once the drain ends', async () => {
    setDeliverDrain(() => false);
    const { deps } = rig();
    const runGates = vi.fn(async () => ({ reason: null, failed: [] }));
    await autoDeliverAfterConflict({ ...deps, runGates });
    expect(runGates).toHaveBeenCalled();
  });

  it('refuses a skipped-gate re-run while draining', async () => {
    setDeliverDrain(() => true);
    const runGates = vi.fn();
    const log: string[] = [];
    const out = await rerunSkippedGates({
      ticketId: 1, key: 'T1', skipped: ['unit'], agentActive: () => false, runGates,
      note: () => undefined, log: (m) => log.push(m),
    });
    expect(out).toBe('refused');
    expect(runGates).not.toHaveBeenCalled();
    expect(log.some((l) => l.includes('draining'))).toBe(true);
  });

  it('lists the ticket of a running auto-deliver, also before it opens its run row', async () => {
    expect(liveDeliverTickets()).toEqual([]);
    let during: number[] = [];
    const { deps } = rig({ runGates: async () => { during = liveDeliverTickets(); return { reason: null, failed: [] }; } });
    await autoDeliverAfterConflict(deps);
    expect(during).toEqual([1]);
    expect(liveDeliverTickets()).toEqual([]);
  });

  it('runs an auto-deliver inside the drain track, so its push is not refused after the drain begins', async () => {
    const drain = createDrain();
    setDeliverDrain(() => drain.isDraining(), (fn) => drain.track(fn));
    let insideAtPush: boolean | null = null;
    let inFlightDuring = -1;
    const { deps } = rig({
      runGates: async () => { drain.begin(); inFlightDuring = drain.inFlight(); return { reason: null, failed: [] }; },
      runShip: async () => { insideAtPush = drain.insideRun(); return { kind: 'delivered' } as never; },
    });
    await autoDeliverAfterConflict(deps);
    expect(inFlightDuring).toBe(1);
    expect(insideAtPush).toBe(true);
    expect(drain.inFlight()).toBe(0);
  });

  it('runs a skipped-gate re-run inside the drain track', async () => {
    const drain = createDrain();
    setDeliverDrain(() => drain.isDraining(), (fn) => drain.track(fn));
    let inside: boolean | null = null;
    await rerunSkippedGates({
      ticketId: 1, key: 'T1', skipped: ['unit'], agentActive: () => false,
      runGates: async () => { inside = drain.insideRun(); return { kind: 'passed', headSha: null }; },
      note: () => undefined, log: () => undefined,
    });
    expect(inside).toBe(true);
  });

});

describe('the environment re-run of the ship gates (T1315)', () => {
  const ENV = 'base check skipped: some vitest failures are not parseable';

  it('re-runs only the failed gates once and pushes when every failure carried an environment signature', async () => {
    const only: Array<readonly string[] | undefined> = [];
    const { deps, rounds, log } = rig({
      runGates: async (_prs, _signal, names) => {
        only.push(names);
        return names === undefined ? failedRun(['unit', ENV]) : { reason: null, failed: [] };
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(only).toEqual([undefined, ['unit']]);
    expect(log).toContain('ship');
    expect(rounds.armed(1)).toBeNull();
    expect(log.some((l) => l.includes('auto-deliver: re-running the failed gates once, every failure carried an environment signature: unit (the base check could not parse the vitest failures)'))).toBe(true);
  });

  it('re-runs only the repo that failed, never the repo whose gates already passed', async () => {
    const prs = [
      { repo: 'other', number: 3, branch: 'b', cwd: '/o' },
      { repo: 'karst', number: 7, branch: 'feat/x', cwd: '/wt' },
    ];
    const asked: string[][] = [];
    const { deps, log } = rig({
      targets: () => ({ available: true, prs }),
      runGates: async (gated, _signal, names) => {
        asked.push(gated.map((p) => p.repo));
        return names === undefined ? failedRun(['unit', ENV]) : { reason: null, failed: [] };
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(asked).toEqual([['other', 'karst'], ['karst']]);
    expect(log).toContain('ship');
  });

  it('reads the signature from the stored summary when the output is gone', async () => {
    const only: Array<readonly string[] | undefined> = [];
    const { deps, log } = rig({
      runGates: async (_prs, _signal, names) => {
        only.push(names);
        return names === undefined
          ? { reason: 'r: gate "unit" failed', failed: [{ name: 'unit', repo: 'karst', output: '', summary: 'environment signature: a gate or test timeout\ntest: 1 failed' }] }
          : { reason: null, failed: [] };
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(only).toEqual([undefined, ['unit']]);
    expect(log).toContain('ship');
  });

  it('refuses a real failure with no re-run', async () => {
    const calls: number[] = [];
    const { deps, rounds, log } = rig({
      runGates: async () => {
        calls.push(1);
        return failedRun(['unit', 'AssertionError: expected 1 to be 2']);
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(calls).toHaveLength(1);
    expect(log).not.toContain('ship');
    expect(rounds.armed(1)).not.toBeNull();
  });

  it('refuses a mixed failure with no re-run: one signed gate does not make the round an environment fault', async () => {
    const calls: number[] = [];
    const { deps, log } = rig({
      runGates: async () => {
        calls.push(1);
        return failedRun(['unit', ENV], ['typecheck', 'src/a.ts(2,3): error TS2322']);
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(calls).toHaveLength(1);
    expect(log).not.toContain('ship');
  });

  it('refuses with no re-run when the run named no failed gate (a gate that could not run)', async () => {
    const calls: number[] = [];
    const { deps, log } = rig({
      runGates: async () => {
        calls.push(1);
        return { reason: 'r: gate "docs" could not run (refused by the host boundary)', failed: [] };
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(calls).toHaveLength(1);
    expect(log).not.toContain('ship');
  });

  it('re-runs EVERY signed failed gate, and names them one by one in the log', async () => {
    const only: Array<readonly string[] | undefined> = [];
    const { deps, log } = rig({
      runGates: async (_prs, _signal, names) => {
        only.push(names);
        return names === undefined
          ? failedRun(['unit', ENV], ['visual', 'not a screenshot mismatch'])
          : { reason: null, failed: [] };
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(only).toEqual([undefined, ['unit', 'visual']]);
    expect(log.some((l) => l.includes('every failure carried an environment signature: unit (the base check could not parse the vitest failures), visual (a failure that is not a screenshot mismatch)'))).toBe(true);
    expect(log).toContain('ship');
  });

  it('refuses with no re-run when a repo after the failing one never gated', async () => {
    const calls: number[] = [];
    const { deps, log } = rig({
      runGates: async () => {
        calls.push(1);
        return { ...failedRun(['unit', ENV], ['visual', 'not a screenshot mismatch']), incomplete: true };
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(calls).toHaveLength(1);
    expect(log).not.toContain('ship');
    expect(log.some((l) => l.includes('the failed gates are not re-run, a repo after the failing one never gated: unit (the base check could not parse the vitest failures), visual (a failure that is not a screenshot mismatch)'))).toBe(true);
  });

  it('refuses and pushes nothing when the re-run fails too', async () => {
    const only: Array<readonly string[] | undefined> = [];
    const { deps, rounds, log } = rig({
      runGates: async (_prs, _signal, names) => {
        only.push(names);
        return failedRun(['unit', ENV]);
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(only).toEqual([undefined, ['unit']]);
    expect(log).not.toContain('ship');
    expect(rounds.armed(1)).not.toBeNull();
    expect(log.some((l) => l.startsWith('error:Resolved merge not delivered: a ship-stage gate failed'))).toBe(true);
  });
});

describe('the refused delivery of a verified merge (T1315)', () => {
  const ENV = 'exceeded the test timeout';
  const SHA = '2cc2990' + 'a'.repeat(33);

  it('records the gate and the merge commit the manual Deliver pushes', async () => {
    const { deps, rounds } = rig({
      runGates: async () => ({ reason: 'r: gate "unit" failed (exit 1)', failed: [{ name: 'unit', repo: 'karst', output: `1 failed: ${ENV}` }] }),
      mergeSha: async () => SHA,
    });
    await autoDeliverAfterConflict(deps);
    expect(rounds.refusal(1)).toEqual({ repo: 'karst', tail: 'gate "unit" failed', sha: SHA, runId: null, baseRef: null, baseSha: ROUND.baseSha });
    // The round stays armed for the manual Deliver and for the park the engine writes: a refusal is not a disarm.
    expect(rounds.armed(1)).not.toBeNull();
  });

  it('binds the base of the FAILING repo but guards the conflicted merge (T1381)', async () => {
    const store = openStore(':memory:');
    setMergeCheck(store, { ticketId: 1, repo: 'api', state: 'clean', files: [], reason: null, headSha: 'apih', baseSha: 'apibase', baseRef: 'main', checkedAt: 'x' });
    const api = { repo: 'api', number: 9, branch: 'feat/api', cwd: '/wt/api' };
    const read: string[] = [];
    const { deps, rounds } = rig({
      store,
      targets: () => ({ available: true, prs: [OPEN.prs[0]!, api] }),
      runGates: async () => ({ reason: 'api: gate "unit" failed (exit 1)', failed: [{ name: 'unit', repo: 'api', output: 'x' }] }),
      mergeSha: async (pr) => { read.push(pr.repo); return SHA; },
      baseRef: (pr) => (pr.repo === 'api' ? 'main' : 'develop'),
    });
    await autoDeliverAfterConflict(deps);
    // The guard is the conflicted repo's merge (unpushed); the failing repo's base names the failure. Binding the guard to
    // the failing repo's head would name an ALREADY-PUSHED commit and the delivered check would drop the refusal.
    expect(rounds.refusal(1)).toEqual({ repo: 'karst', tail: 'gate "unit" failed', sha: SHA, runId: null, baseRef: 'main', baseSha: 'apibase' });
    expect(read).toEqual(['karst']);
  });

  it('records the round repo when the failed run names no gate', async () => {
    const { deps, rounds } = rig({
      runGates: async () => ({ reason: 'r: gate run was stopped', failed: [] }),
      mergeSha: async () => SHA,
    });
    await autoDeliverAfterConflict(deps);
    // No failed gate: the round's own repo is the only one to name, and the tail is the generic one.
    expect(rounds.refusal(1)).toEqual({ repo: 'karst', tail: 'a ship gate failed', sha: SHA, runId: null, baseRef: null, baseSha: ROUND.baseSha });
  });

  it('leaves the sha unread when the host has no merge-sha seam', async () => {
    const { deps, rounds } = rig({
      runGates: async () => ({ reason: 'r: gate "unit" failed', failed: [{ name: 'unit', repo: 'karst', output: 'x' }] }),
    });
    await autoDeliverAfterConflict(deps);
    expect(rounds.refusal(1)).toEqual({ repo: 'karst', tail: 'gate "unit" failed', sha: null, runId: null, baseRef: null, baseSha: ROUND.baseSha });
  });

  it('words the tail of a run that named no gate', () => {
    expect(shipGateFailureTail({ reason: 'r: gate run was stopped', failed: [] })).toBe('a ship gate failed');
    expect(shipGateFailureTail({ reason: 'r: gate "unit" failed', failed: [{ name: 'unit', repo: 'r', output: '' }] })).toBe('gate "unit" failed');
  });

  it('records the base check as the refusal when only the moved base failed', async () => {
    const { deps, rounds } = rig({
      checkBase: async () => 'fails when merged with origin/develop abc; CI tests this merge',
      mergeSha: async () => SHA,
    });
    await autoDeliverAfterConflict(deps);
    expect(rounds.refusal(1)).toEqual({ repo: 'karst', tail: 'the base check failed', sha: SHA, runId: null, baseRef: null, baseSha: ROUND.baseSha });
  });

  it('records no refusal when the merge is unfinished (the stall path owns that round)', async () => {
    const { deps, rounds } = rig({ verifyMerge: async () => 'the worktree has uncommitted changes' });
    await autoDeliverAfterConflict(deps);
    expect(rounds.refusal(1)).toBeNull();
  });

  it('records no refusal while a manual Deliver took over', async () => {
    const calls: Array<readonly string[] | undefined> = [];
    const { deps, rounds } = rig({
      runGates: async (_prs, _signal, names) => {
        calls.push(names);
        takeOverAutoDeliver(1, { rounds, recordTakeOver: () => ({ failed: [], skipped: [] }), note: () => undefined, key: 'T1' });
        return { reason: 'r: gate "unit" failed', failed: [{ name: 'unit', repo: 'karst', output: 'x' }] };
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(rounds.refusal(1)).toBeNull();
    expect(calls).toEqual([undefined]);
  });

  it('starts no environment re-run behind a manual Deliver that took over', async () => {
    const calls: Array<readonly string[] | undefined> = [];
    const { deps, log } = rig({
      runGates: async (_prs, _signal, names) => {
        calls.push(names);
        takeOverAutoDeliver(1, { rounds: createConflictRounds(), recordTakeOver: () => ({ failed: [], skipped: [] }), note: () => undefined, key: 'T1' });
        return failedRun(['unit', 'exceeded the test timeout']);
      },
    });
    await autoDeliverAfterConflict(deps);
    expect(calls).toEqual([undefined]);
    expect(log).not.toContain('ship');
  });

  it('leaves no sha when git cannot read the merge commit', async () => {
    const { deps, rounds } = rig({
      runGates: async () => ({ reason: 'r: gate "unit" failed', failed: [{ name: 'unit', repo: 'karst', output: 'x' }] }),
      mergeSha: async () => { throw new Error('git is gone'); },
    });
    await autoDeliverAfterConflict(deps);
    expect(rounds.refusal(1)).toEqual({ repo: 'karst', tail: 'gate "unit" failed', sha: null, runId: null, baseRef: null, baseSha: ROUND.baseSha });
  });
});

describe('the refusal carries the deliver run that refused the merge (T1381)', () => {
  const SHA = '2cc2990' + 'a'.repeat(33);

  it('records the run id, base ref and base sha of a gate refusal', async () => {
    const { deps, rounds } = rig({
      runGates: async () => ({ reason: 'r: gate "unit" failed', failed: [{ name: 'unit', repo: 'karst', output: 'x' }] }),
      mergeSha: async () => SHA,
      lastRunId: () => 42,
      baseRef: () => 'develop',
    });
    await autoDeliverAfterConflict(deps);
    expect(rounds.refusal(1)).toEqual({
      repo: 'karst', tail: 'gate "unit" failed', sha: SHA, runId: 42, baseRef: 'develop', baseSha: ROUND.baseSha,
    });
  });

  it('records the run id of the re-run after every gate carries an environment signature', async () => {
    let opened = 0;
    const { deps, rounds } = rig({
      runGates: async () => {
        opened += 1;
        return { reason: 'r: gate "unit" failed', failed: [{ name: 'unit', repo: 'karst', output: 'exceeded the test timeout' }] };
      },
      mergeSha: async () => SHA,
      lastRunId: () => opened,
      baseRef: () => 'develop',
    });
    await autoDeliverAfterConflict(deps);
    // Two gate runs (first + environment re-run): the refusal names the LAST one.
    expect(rounds.refusal(1)).toMatchObject({ runId: 2, baseRef: 'develop', baseSha: ROUND.baseSha });
  });

  it('records them for a base check refusal too', async () => {
    const { deps, rounds } = rig({
      checkBase: async () => 'fails when merged with origin/develop abc; CI tests this merge',
      mergeSha: async () => SHA,
      lastRunId: () => 7,
      baseRef: () => 'develop',
    });
    await autoDeliverAfterConflict(deps);
    expect(rounds.refusal(1)).toEqual({
      repo: 'karst', tail: 'the base check failed', sha: SHA, runId: 7, baseRef: 'develop', baseSha: ROUND.baseSha,
    });
  });

  it('records nulls when no seam read the run or the base', async () => {
    const { deps, rounds } = rig({
      runGates: async () => ({ reason: 'r: gate "unit" failed', failed: [{ name: 'unit', repo: 'karst', output: 'x' }] }),
    });
    await autoDeliverAfterConflict(deps);
    expect(rounds.refusal(1)).toMatchObject({ runId: null, baseRef: null, baseSha: ROUND.baseSha });
  });
});

describe('conflictRoundEnded (T1287)', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'K-1', title: 't' }).id;
  });
  afterEach(() => store.close());

  const conflicted = (): void => {
    setMergeCheck(store, { ticketId: id, repo: 'karst', state: 'conflicted', files: ['a.ts'], reason: null, headSha: 'local', baseSha: 'b4se', baseRef: 'develop', checkedAt: 'x' });
  };
  const clean = (): void => {
    setMergeCheck(store, { ticketId: id, repo: 'karst', state: 'clean', files: [], reason: null, headSha: 'local', baseSha: 'b4se', baseRef: 'develop', checkedAt: 'x' });
  };
  const git = (code: number) => vi.fn(async () => ({ code, stdout: '' }));

  function deps(over: Partial<Parameters<typeof conflictRoundEnded>[0]> = {}) {
    const rounds = createConflictRounds();
    rounds.arm(id, ROUND);
    return {
      store, ticketId: id, rounds, prHead: () => 'on-pr', cwd: () => '/wt', git: git(0),
      ...over,
    } satisfies Parameters<typeof conflictRoundEnded>[0];
  }

  it('is true when the stored check names no conflict and the PR head contains the round base head', async () => {
    clean();
    const d = deps();
    expect(await conflictRoundEnded(d)).toBe(true);
    expect(d.git).toHaveBeenCalledWith('/wt', ['merge-base', '--is-ancestor', 'b4se', 'on-pr']);
  });

  it('is false while the stored check is still conflicted, even when the PR head carries the base', async () => {
    conflicted();
    expect(await conflictRoundEnded(deps())).toBe(false);
  });

  it('is false when the PR head is unknown', async () => {
    clean();
    expect(await conflictRoundEnded(deps({ prHead: () => null }))).toBe(false);
  });

  it('is false when the PR head does not contain the round base head from the last merge check', async () => {
    clean();
    expect(await conflictRoundEnded(deps({ git: git(1) }))).toBe(false);
  });

  it('is false when the round repo has no worktree to read', async () => {
    clean();
    expect(await conflictRoundEnded(deps({ cwd: () => null }))).toBe(false);
  });

  it('needs no git read when the round recorded no base head', async () => {
    clean();
    const rounds = createConflictRounds();
    rounds.arm(id, { ...ROUND, baseSha: null });
    const g = git(1);
    expect(await conflictRoundEnded({ store, ticketId: id, rounds, prHead: () => 'on-pr', cwd: () => '/wt', git: g })).toBe(true);
    expect(g).not.toHaveBeenCalled();
  });

  it('is false when no round is armed', async () => {
    clean();
    const rounds = createConflictRounds();
    expect(await conflictRoundEnded({ store, ticketId: id, rounds, prHead: () => 'on-pr', cwd: () => '/wt', git: git(0) })).toBe(false);
  });

  it('ends a round whose stored merge check row is gone, on the PR head alone', async () => {
    const rounds = createConflictRounds();
    rounds.arm(id, ROUND);
    expect(await conflictRoundEnded({ store, ticketId: id, rounds, prHead: () => 'on-pr', cwd: () => '/wt', git: git(0) })).toBe(true);
  });

  it('is false while the auto-deliver of the round runs', async () => {
    clean();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const rounds = createConflictRounds();
    rounds.arm(id, ROUND);
    const running = rig({
      ticketId: id,
      rounds,
      runGates: async () => { await gate; return { reason: null, failed: [] }; },
    });
    const run = autoDeliverAfterConflict(running.deps);
    await vi.waitFor(() => expect(isAutoDelivering(id)).toBe(true));
    expect(await conflictRoundEnded({
      store, ticketId: id, rounds: running.rounds, prHead: () => 'on-pr', cwd: () => '/wt', git: git(0),
    })).toBe(false);
    release();
    await run;
    expect(isAutoDelivering(id)).toBe(false);
  });
});

describe('endConflictRoundOnDeliver (T1287)', () => {
  it('a refused auto-deliver keeps the round; the later manual deliver of the merge ends it with one line', async () => {
    const { deps, rounds, log } = rig({ runGates: async () => ({ reason: 'gate "docs" failed (exit 1)', failed: [] }) });
    await autoDeliverAfterConflict(deps);
    expect(rounds.armed(1)).not.toBeNull();
    expect(endConflictRoundOnDeliver(rounds, 1, 'T1', (m) => log.push(`log:${m}`))).toBe(true);
    expect(rounds.armed(1)).toBeNull();
    expect(log).toContain('log:[ship] ticket T1: the conflict round ended, the merge was delivered to the PR');
  });

  it('does nothing and logs nothing when no round is armed', () => {
    const rounds = createConflictRounds();
    const log: string[] = [];
    expect(endConflictRoundOnDeliver(rounds, 1, 'T1', (m) => log.push(m))).toBe(false);
    expect(log).toEqual([]);
  });

  it('frees the round slot in the store through the disarm hook', () => {
    let freed = 0;
    const rounds = createConflictRounds(() => { freed += 1; });
    rounds.arm(1, ROUND);
    expect(endConflictRoundOnDeliver(rounds, 1, 'T1', () => undefined)).toBe(true);
    expect(freed).toBe(1);
  });
});
