import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, pauseTicket, setAgentState, setStageCurrent } from '../../store/tickets.js';
import { ensureStage, removeStage, setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { clearConflictRound, getAutopilotRerun, getCiRoundAt, getConflictRoundAt, markConflictRound, getAutopilotBudget, getAutopilotTicket, getRefusedMerge, takeAutopilotAttempt, setCiRoundHeadSha, getCiRoundHeadSha, setAutopilotOverride, setAutopilotPaused, setAutopilotStopAfter, setAutopilotStopped } from '../../store/autopilot.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { sendBackToImplement } from '../../workflow/sendBack.js';
import { autopilotTick, NO_CHANGE_BASE_MOVED_REASON, ROUND_LAUNCH_DEATH_WINDOW_MS, roundDied, stopAutopilot, allChecksAllowed, approveOneMore, clearParkBlock, type AutopilotDeps, type FixOutcome } from './autopilotOps.js';
import { AUTO_SHIP_RETRY_STOP_REASON } from './autopilotShipRetry.js';
import { recordEvent } from '../../store/karstEvents.js';
import { upsertProject } from '../../store/projects.js';
import { beginShipOperationPreparation, closeShipRun, finishShipRepoStep, openShipRepoStep, openShipRun } from '../../store/shipRuns.js';
import { conflictRounds, conflictRoundEnded, createConflictRounds } from './autoDeliverOps.js';
import { UNFINISHED_BODY } from './autopilotRefusal.js';
import { makePlacementCheck } from '../autopilotBinding.js';
import { getPlacement, recordPlacementIfAbsent, GRAPH_RUN_PLACEMENT } from '../../store/placement.js';
import { createGraphRun } from '../../store/graph/graphRuns.js';
import { openDeliverRun, recordDeliverGate, finishDeliverRun } from '../../store/deliverRuns.js';
import { deliverRunFailureState, type BaseMovedFailureState } from '../../workflow/baseMovedFailure.js';
import { baseRefOf } from './baseMovedFailureOps.js';

const NORMAL_BLOCK = 'blocked: the pull request for "r" has changes and is not merged yet.';
let store: Store;
let id: number;

const CFG: AutopilotConfig = {
  enabled: true,
  ci: { policy: 'auto', maxAttempts: 3, checks: ['build', 'lint'] },
  conflicts: { policy: 'auto', maxRounds: 2 },
};

function seedPr(checks?: unknown, status = 'open'): void {
  store.db.prepare('INSERT OR IGNORE INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w/r', 'b');
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'r', 5, 'https://github.com/o/r/pull/5', status, checks === undefined ? null : JSON.stringify(checks));
}
const failing = (...names: string[]) => ({
  state: 'failing', total: 3, passed: 1, failed: names.length, pending: 0, failedShown: names.length,
  failing: names.map((name) => ({ name, url: null })),
});
function cleanMerge(): void {
  setMergeCheck(store, { ticketId: id, repo: 'r', state: 'clean', files: [], reason: null, headSha: 'h', baseSha: 'base1', baseRef: 'develop', checkedAt: '2026-01-01T00:00:00Z' });
}
function conflict(repo = 'r', baseSha: string | null = 'base1'): void {
  store.db.prepare('INSERT OR IGNORE INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, repo, `/w/${repo}`, 'b');
  if (repo !== 'r') {
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, ?, ?, ?, NULL)').run(id, repo, 7, `https://github.com/o/${repo}/pull/7`, 'open');
  }
  setMergeCheck(store, { ticketId: id, repo, state: 'conflicted', files: ['a.ts'], reason: null, headSha: 'h', baseSha, baseRef: 'develop', checkedAt: 'x' });
}

const PASSING = { state: 'passing', total: 3, passed: 3, failed: 0, pending: 0, failedShown: 0, failing: [] };

interface Rig { deps: AutopilotDeps; notes: Array<[string, string]>; debug: ReturnType<typeof vi.fn>; sendCi: ReturnType<typeof vi.fn>; sendConflict: ReturnType<typeof vi.fn> }
function rig(over: Partial<AutopilotDeps> = {}, outcome: FixOutcome = { kind: 'sent' }): Rig {
  const notes: Array<[string, string]> = [];
  const debug = vi.fn();
  const sendCi = vi.fn(async () => outcome);
  const sendConflict = vi.fn(async (_repo: string) => outcome);
  const deps: AutopilotDeps = {
    store, ticketId: id, key: 'AP-1', config: () => CFG,
    controls: () => true, sessionRunning: () => false, concurrencyFull: () => false,
    placement: async () => 'host', isGraphTicket: () => false, sendCiFailure: sendCi, sendConflict, conflictRoundActive: () => false, conflictRoundStalled: () => false, dropConflictRound: () => {},
    note: (t, b) => void notes.push([t, b]), debug, ...over,
  };
  return { deps, notes, debug, sendCi, sendConflict };
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'AP-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
  parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: NORMAL_BLOCK, runAt: '2026-08-09T10:00:00.000Z', gates: [] });
});

describe('allChecksAllowed', () => {
  it('needs every failing name on a non-empty allowlist', () => {
    expect(allChecksAllowed(['a'], ['a', 'b'])).toBe(true);
    expect(allChecksAllowed(['a', 'c'], ['a', 'b'])).toBe(false);
    expect(allChecksAllowed(['a'], [])).toBe(false);
    expect(allChecksAllowed([], ['a'])).toBe(false);
  });
});

const spend = async (n: number): Promise<void> => { for (let i = 0; i < n; i += 1) await autopilotTick(rig().deps); };

describe('autopilotTick gating', () => {
  it('is off by default, when the manifest block is missing, or when the ticket override is off', async () => {
    seedPr(failing('build'));
    expect(await autopilotTick(rig({ config: () => ({ ...CFG, enabled: false }) }).deps)).toEqual({ kind: 'off' });
    expect(await autopilotTick(rig({ config: () => undefined }).deps)).toEqual({ kind: 'off' });
    setAutopilotOverride(store, id, 'off');
    expect(await autopilotTick(rig().deps)).toEqual({ kind: 'off' });
    setAutopilotOverride(store, id, 'on');
    expect((await autopilotTick(rig({ config: () => ({ ...CFG, enabled: false }) }).deps)).kind).toBe('armed');
  });

  it('does nothing while a session runs, in another window, or when the concurrency limit is full', async () => {
    seedPr(failing('build'));
    expect((await autopilotTick(rig({ sessionRunning: () => true }).deps)).kind).toBe('busy');
    const other = rig({ controls: () => false });
    expect((await autopilotTick(other.deps)).kind).toBe('not-controller');
    expect(other.sendCi).not.toHaveBeenCalled();
    expect((await autopilotTick(rig({ concurrencyFull: () => true }).deps)).kind).toBe('queued');
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
  });

  it('never acts on a closed PR, a pending or unknown CI, or a merge conflict', async () => {
    seedPr(failing('build'), 'closed');
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
    store.db.prepare('DELETE FROM prs').run();
    seedPr({ ...failing('build'), state: 'pending' });
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
    store.db.prepare('DELETE FROM prs').run();
    seedPr({ ...failing('build'), state: 'unknown', failing: [] });
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
    store.db.prepare('DELETE FROM prs').run();
    seedPr(PASSING);
    setMergeCheck(store, { ticketId: id, repo: 'r', state: 'conflicted', files: ['a.ts'], reason: null, headSha: 'h', baseSha: 'base1', baseRef: 'develop', checkedAt: 'x' });
    const r = rig();
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(r.sendConflict).toHaveBeenCalledWith('r');
  });

  it('two windows never arm the same round: only the controller acts', async () => {
    seedPr(failing('build'));
    const a = rig({ controls: () => true });
    const b = rig({ controls: () => false });
    const [ra, rb] = [await autopilotTick(a.deps), await autopilotTick(b.deps)];
    expect([ra.kind, rb.kind]).toEqual(['armed', 'not-controller']);
    expect(a.sendCi).toHaveBeenCalledTimes(1);
    expect(b.sendCi).not.toHaveBeenCalled();
  });
});

describe('the drain (@arch:DRAIN-01)', () => {
  it('sends no round while the host drains for a reload', async () => {
    seedPr(failing('build'));
    const r = rig({ isDraining: () => true });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'busy' });
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect((await autopilotTick(rig({ isDraining: () => false }).deps)).kind).toBe('armed');
  });
});

describe('ci', () => {
  it('marks the ticket when a ci round is sent, so the driver can re-ship without the click (T1095)', async () => {
    seedPr(failing('build'));
    expect(getCiRoundAt(store, id)).toBeNull();
    await autopilotTick(rig().deps);
    expect(getCiRoundAt(store, id)).not.toBeNull();
  });

  it('does not mark the ticket when the ci action failed', async () => {
    seedPr(failing('build'));
    await autopilotTick(rig({}, { kind: 'failed', reason: 'x' }).deps);
    expect(getCiRoundAt(store, id)).toBeNull();
  });

  it('sends the failure to the agent for an allowlisted check, with a note and an autopilot debug line', async () => {
    seedPr(failing('build'));
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
    expect(r.sendCi).toHaveBeenCalledTimes(1);
    expect(r.notes).toHaveLength(1);
    expect(r.debug.mock.calls[0]![0]).toMatch(/^\[ship\] autopilot /);
  });

  it('honours the ask policy', async () => {
    seedPr(failing('build'));
    const r = rig({ config: () => ({ ...CFG, ci: { ...CFG.ci, policy: 'ask' } }) });
    expect((await autopilotTick(r.deps)).kind).toBe('ask');
    expect(r.sendCi).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown check', ['build', 'e2e'], ['build', 'lint']],
    ['an empty allowlist', ['build'], []],
  ])('parks and notes for %s without calling the action', async (_n, names, checks) => {
    seedPr(failing(...names));
    const r = rig({ config: () => ({ ...CFG, ci: { ...CFG.ci, checks } }) });
    const out = await autopilotTick(r.deps);
    expect(out.kind).toBe('parked');
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(r.notes).toHaveLength(1);
  });

  it('parks with "auto-fix stopped: ci 3/3" once the budget is spent, with ONE note across repeat ticks', async () => {
    seedPr(failing('build'));
    await spend(3);
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci 3/3' });
    await autopilotTick(r.deps);
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(r.notes).toHaveLength(1);
  });

  it('resets when a different set of checks fails, and counts a repeat of the same set', async () => {
    seedPr(failing('build'));
    await spend(2);
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(2);
    store.db.prepare('UPDATE prs SET checks = ?').run(JSON.stringify(failing('build', 'lint')));
    await autopilotTick(rig().deps);
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
  });

  it('approve-one-more grants one more attempt, records a note, and does not reset', async () => {
    seedPr(failing('build'));
    await spend(4);
    const notes: string[] = [];
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: (t) => void notes.push(t), debug: () => {} }, 'r', 'ci');
    expect(notes).toHaveLength(1);
    expect(await autopilotTick(rig().deps)).toMatchObject({ kind: 'armed', used: 4, max: 4 });
    expect((await autopilotTick(rig().deps)).kind).toBe('parked');
  });

  it('parks with the fetch error when gh fails, uses no attempt, and does not retry', async () => {
    seedPr(failing('build'));
    const r = rig({}, { kind: 'failed', reason: 'gh run view failed' });
    const out = await autopilotTick(r.deps);
    expect(out).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci could not run (gh run view failed)' });
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    await autopilotTick(r.deps);
    expect(r.notes).toHaveLength(1);
    expect(r.sendCi).toHaveBeenCalledTimes(1);
  });

  it('parks with the error and refunds the attempt when the action throws', async () => {
    seedPr(failing('build'));
    const r = rig({ sendCiFailure: async () => { throw new Error('boom'); } });
    const out = await autopilotTick(r.deps);
    expect(out).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci could not run (boom)' });
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(r.notes).toHaveLength(1);
  });
});

describe('placement: host, sandbox or unknown', () => {
  it('runs the same CI round for a sandboxed ticket as for a host ticket', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => 'sandbox', sandboxPreflight: async () => null });
    expect(await autopilotTick(r.deps)).toMatchObject({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
    expect(r.sendCi).toHaveBeenCalledTimes(1);
  });

  it('parks a placement that cannot be read, with a note, no attempt and no round', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => { throw new Error('probe failed'); } });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix not run: placement unknown' });
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]![0]).toBe('Autopilot: auto-fix not run: placement unknown');
    expect(stageBlock(store, id, 'ship')).toMatchObject({ kind: 'awaiting-merge', reason: 'auto-fix not run: placement unknown' });
    await autopilotTick(r.deps);
    expect(r.notes).toHaveLength(1);
  });

  it('does not run the sandbox preflight for a host ticket', async () => {
    seedPr(failing('build'));
    const sandboxPreflight = vi.fn(async () => 'never asked');
    const r = rig({ sandboxPreflight });
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(sandboxPreflight).not.toHaveBeenCalled();
  });

  it('lets the allowlist park come first for a sandboxed ticket', async () => {
    seedPr(failing('e2e'));
    const r = rig({ placement: async () => 'sandbox' });
    expect(await autopilotTick(r.deps)).toMatchObject({ reason: expect.stringContaining('is not on the allowlist') });
  });

  it('waits when CI is not failing: a sandboxed ticket with no failure is left alone', async () => {
    seedPr({ ...failing('build'), state: 'pending' });
    const sandboxPreflight = vi.fn(async () => null);
    const r = rig({ placement: async () => 'sandbox', sandboxPreflight });
    expect((await autopilotTick(r.deps)).kind).toBe('nothing');
    expect(r.notes).toHaveLength(0);
    expect(sandboxPreflight).not.toHaveBeenCalled();
  });
});

describe('sandbox environment blockers (arch:AC-31, AC-46, AC-47)', () => {
  const BLOCKER = 'the sandbox clone has uncommitted changes';
  const blocked = (over: Partial<AutopilotDeps> = {}): Rig => rig({ placement: async () => 'sandbox', sandboxPreflight: async () => BLOCKER, ...over });

  it('parks a CI round at once in ship, before the hand-off, with the paused reason and no attempt used', async () => {
    seedPr(failing('build'));
    const r = blocked();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: `auto-fix paused: sandbox ${BLOCKER}` });
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(stageBlock(store, id, 'ship')).toMatchObject({ kind: 'awaiting-merge', reason: `auto-fix paused: sandbox ${BLOCKER}` });
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('stores the blocker as a paused state, apart from a spent budget', async () => {
    seedPr(failing('build'));
    await autopilotTick(blocked().deps);
    const state = getAutopilotTicket(store, id);
    expect(state.pausedReason).toBe(`auto-fix paused: sandbox ${BLOCKER}`);
    expect(getAutopilotBudget(store, id, 'r', 'ci')).toMatchObject({ attempts: 0 });
  });

  it('does not retry a blocker: later ticks run no preflight and no round', async () => {
    seedPr(failing('build'));
    const sandboxPreflight = vi.fn(async () => BLOCKER);
    const r = blocked({ sandboxPreflight });
    await autopilotTick(r.deps);
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'idle' });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'idle' });
    expect(sandboxPreflight).toHaveBeenCalledTimes(1);
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(r.notes).toHaveLength(1);
  });

  it('treats a preflight that rejects as a blocker, with the message and not a host fallback', async () => {
    seedPr(failing('build'));
    const r = blocked({ sandboxPreflight: async () => { throw new Error('sbx ls failed'); } });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix paused: sandbox sbx ls failed' });
    expect(r.sendCi).not.toHaveBeenCalled();
  });

  it('gives back the attempts of every failing PR when the preflight blocks', async () => {
    seedPr(failing('build'));
    store.db.prepare('INSERT OR IGNORE INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r2', '/w/r2', 'b');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'r2', 6, 'https://github.com/o/r2/pull/6', 'open', JSON.stringify(failing('lint')));
    await autopilotTick(blocked().deps);
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(getAutopilotBudget(store, id, 'r2', 'ci').attempts).toBe(0);
  });

  it('parks a conflict round the same way, never sending Resolve conflicts', async () => {
    seedPr(PASSING);
    conflict();
    const r = blocked();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: `auto-fix paused: sandbox ${BLOCKER}` });
    expect(r.sendConflict).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
  });

  it('a sent conflict round of a sandboxed ticket uses Resolve conflicts (sendConflict), never a rebase', async () => {
    seedPr(PASSING);
    conflict();
    const r = rig({ placement: async () => 'sandbox', sandboxPreflight: async () => null });
    expect(await autopilotTick(r.deps)).toMatchObject({ kind: 'armed', problem: 'conflicts' });
    expect(r.sendConflict).toHaveBeenCalledWith('r');
  });

  it('an env-blocker outcome of the action (read-only sandbox at launch) gives the attempt back and pauses, in ship', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => 'sandbox' }, { kind: 'env-blocker', reason: 'sandbox is read-only' });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix paused: sandbox sandbox is read-only' });
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(getAutopilotTicket(store, id).pausedReason).toBe('auto-fix paused: sandbox sandbox is read-only');
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'idle' });
    expect(r.sendCi).toHaveBeenCalledTimes(1);
  });

  it('an env-blocker outcome after the hand-off left ship pauses with the same reason', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => 'sandbox' });
    r.sendCi.mockImplementation(async () => { setStageCurrent(store, id, 'impl'); return { kind: 'env-blocker', reason: 'dependency setup failed' } as FixOutcome; });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix paused: sandbox dependency setup failed' });
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(getAutopilotTicket(store, id).pausedReason).toBe('auto-fix paused: sandbox dependency setup failed');
  });

  it('an env-blocker outcome of a conflict round drops the round and uses no attempt', async () => {
    seedPr(PASSING);
    conflict();
    const dropConflictRound = vi.fn();
    const r = rig({ placement: async () => 'sandbox', dropConflictRound }, { kind: 'env-blocker', reason: 'the sandbox clone has diverged' });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix paused: sandbox the sandbox clone has diverged' });
    expect(dropConflictRound).toHaveBeenCalledTimes(1);
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
  });
});

describe('a session that dies right after launch (roundDied)', () => {
  const deps = (r: Rig, drop = vi.fn()) => ({ store, ticketId: id, key: 'AP-1', note: r.deps.note, debug: r.deps.debug, dropConflictRound: drop });

  it('undoes a conflict round: attempt back, round dropped, paused, no retry', async () => {
    seedPr(PASSING);
    conflict();
    const r = rig({ placement: async () => 'sandbox', sandboxPreflight: async () => null });
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(1);
    const drop = vi.fn();
    const result = roundDied(deps(r, drop), 'sbx sandbox launch failed (exit 1): boom');
    expect(result).toEqual({ kind: 'parked', reason: 'auto-fix paused: conflicts session died after launch (sbx sandbox launch failed (exit 1): boom)' });
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(getConflictRoundAt(store, id)).toBeNull();
    expect(getAutopilotTicket(store, id).pausedReason).toContain('conflicts session died after launch');
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'idle' });
    expect(r.sendConflict).toHaveBeenCalledTimes(1);
  });

  it('undoes a CI round whose hand-off moved the ticket to Implement', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => 'sandbox', sandboxPreflight: async () => null });
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    setStageCurrent(store, id, 'impl');
    const result = roundDied(deps(r), 'sbx sandbox launch failed (exit 1)');
    expect(result).toMatchObject({ kind: 'parked', reason: expect.stringContaining('ci session died after launch') });
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(getAutopilotTicket(store, id).pausedReason).toBe('auto-fix paused: ci session died after launch (sbx sandbox launch failed (exit 1))');
    expect(r.notes.at(-1)![0]).toBe('Autopilot: auto-fix paused: ci session died after launch (sbx sandbox launch failed (exit 1))');
    expect(r.notes.at(-1)![1]).toContain('the attempt was given back');
  });

  it('parks a CI round that is still in ship on the ship row', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => 'sandbox' });
    await autopilotTick(r.deps);
    roundDied(deps(r), 'boom');
    expect(stageBlock(store, id, 'ship')?.reason).toBe('auto-fix paused: ci session died after launch (boom)');
    expect(r.notes.at(-1)![0]).toBe('Autopilot: auto-fix paused: ci session died after launch (boom)');
  });

  it('ignores a launch failure that comes after the launch window: the round was healthy', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => 'sandbox', sandboxPreflight: async () => null });
    const now = vi.spyOn(Date, 'now');
    try {
      expect((await autopilotTick(r.deps)).kind).toBe('armed');
      now.mockReturnValue(Date.now() + ROUND_LAUNCH_DEATH_WINDOW_MS + 1);
      expect(roundDied(deps(r), 'a later relaunch failed')).toBeNull();
    } finally {
      now.mockRestore();
    }
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
    expect(getAutopilotTicket(store, id).pausedReason).toBeNull();
  });

  it('does nothing when no round was sent for the ticket, or when it was already undone', async () => {
    const r = rig();
    expect(roundDied(deps(r), 'boom')).toBeNull();
    seedPr(failing('build'));
    await autopilotTick(r.deps);
    expect(roundDied(deps(r), 'boom')).not.toBeNull();
    expect(roundDied(deps(r), 'boom')).toBeNull();
  });
});

describe('stopAutopilot', () => {
  const deps = (stopSession: () => Promise<boolean>) => ({ store, ticketId: id, key: 'AP-1', note: () => {}, debug: () => {}, stopSession });

  it('after-round arms nothing new and does not end the session', async () => {
    seedPr(failing('build'));
    const stop = vi.fn(async () => true);
    expect(await stopAutopilot(deps(stop), 'after-round')).toBe('flag-set');
    expect(stop).not.toHaveBeenCalled();
    expect((await autopilotTick(rig().deps)).kind).toBe('idle');
  });

  it('now ends the session through the stop seam when this window holds it', async () => {
    const stop = vi.fn(async () => true);
    expect(await stopAutopilot(deps(stop), 'now')).toBe('ended');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getAutopilotTicket(store, id).stopAfter).toBe(true);
  });

  it('now from a window that does not hold the session says the stop did not reach it', async () => {
    const notes: Array<[string, string]> = [];
    const result = await stopAutopilot({ ...deps(async () => false), note: (t, b) => void notes.push([t, b]) }, 'now');
    expect(result).toBe('not-reached');
    expect(getAutopilotTicket(store, id).stopAfter).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]![1]).toMatch(/did not reach the session/);
    expect(notes[0]![1]).not.toMatch(/ended the session/);
  });
});

const optionalFail = (names: string[], required: boolean | null, split: { total: number; failed: number; pending: number } | null = { total: 2, failed: 0, pending: 0 }) => ({
  ...failing(...names), required: split,
  failing: names.map((name) => ({ name, url: null, required })),
});

describe('optional failing checks (known required split)', () => {
  it('does not park, and clears a stale park, when only a non-allowlisted optional check fails', async () => {
    seedPr(optionalFail(['Mutation score'], false));
    cleanMerge();
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'auto-fix not run: ci check Mutation score is not on the allowlist', runAt: 'x', gates: [] });
    setAutopilotStopped(store, id, 'auto-fix not run: ci check Mutation score is not on the allowlist');
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'cleared' });
    expect(stageBlock(store, id, 'ship')?.reason).toBe(NORMAL_BLOCK);
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(r.notes).toHaveLength(1);
    expect(r.debug).toHaveBeenCalledWith(expect.stringMatching(/^\[ship\] autopilot /));
    await autopilotTick(r.deps);
    expect(r.notes).toHaveLength(1);
  });

  it('starts a round when the only failing optional check is on the allowlist', async () => {
    seedPr(optionalFail(['build'], false));
    const r = rig();
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(r.sendCi).toHaveBeenCalled();
  });

  it('starts a round when a required allowlisted check fails beside a non-allowlisted optional one', async () => {
    seedPr({ ...optionalFail(['build'], true), failing: [{ name: 'build', url: null, required: true }, { name: 'Mutation score', url: null, required: false }], failed: 2, failedShown: 2 });
    const r = rig();
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
  });

  it('parks as today when the required flag is unknown or the split is absent or pending', async () => {
    for (const c of [optionalFail(['Mutation score'], null), optionalFail(['Mutation score'], false, null), optionalFail(['Mutation score'], false, { total: 2, failed: 0, pending: 1 })]) {
      store.db.prepare('DELETE FROM prs').run();
      seedPr(c);
      expect(await autopilotTick(rig().deps)).toMatchObject({ kind: 'parked', reason: expect.stringContaining('is not on the allowlist') });
      clearParkBlock(store, id);
      setAutopilotStopped(store, id, null);
    }
  });

  it('provenClean accepts optional-only failures, so a stalled park clears', async () => {
    seedPr(optionalFail(['Mutation score'], false));
    cleanMerge();
    setAutopilotStopped(store, id, 'auto-fix stopped: conflict round did not deliver');
    const r = rig();
    expect(await autopilotTick(r.deps)).not.toEqual({ kind: 'idle' });
  });
});

describe('notes and debug lines (the history matches a manual click)', () => {
  it('records an armed CI round as Send CI failure to agent', async () => {
    seedPr(failing('build'));
    const r = rig();
    await autopilotTick(r.deps);
    expect(r.notes).toEqual([['Autopilot: ci round 1/3', 'AP-1: ran Send CI failure to agent for r (round 1/3).']]);
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 ci round 1/3 armed for r');
  });

  it('names the check that is off the allowlist, and keeps a repeat quiet', async () => {
    seedPr(failing('build', 'e2e'));
    const r = rig();
    const out = await autopilotTick(r.deps);
    expect(out).toEqual({ kind: 'parked', reason: 'auto-fix not run: ci check e2e is not on the allowlist' });
    expect(r.notes[0]![0]).toBe('Autopilot: auto-fix not run: ci check e2e is not on the allowlist');
    expect(r.notes[0]![1]).toMatch(/^AP-1 \(ci\): /);
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 ci: auto-fix not run: ci check e2e is not on the allowlist');
    await autopilotTick(r.deps);
    expect(r.notes).toHaveLength(1);
    expect(r.debug).toHaveBeenCalledTimes(1);
  });

  it('uses one signature for the same failing set in any order, and de-duplicates a check across PRs', async () => {
    seedPr(failing('lint', 'build', 'build'));
    await autopilotTick(rig().deps);
    expect(store.db.prepare('SELECT signature FROM autopilot_budgets').get()).toEqual({ signature: 'build\nlint' });
  });

  it('a pause alone, or a stop-after alone, idles the ticket', async () => {
    seedPr(failing('build'));
    setAutopilotPaused(store, id, 'auto-fix paused: ci session did not start (x)');
    expect((await autopilotTick(rig().deps)).kind).toBe('idle');
    setAutopilotOverride(store, id, 'inherit');
    setAutopilotStopAfter(store, id);
    expect((await autopilotTick(rig().deps)).kind).toBe('idle');
  });

  it('keeps the park while the CI status is pending', async () => {
    seedPr({ ...failing('build'), state: 'pending' });
    setAutopilotStopped(store, id, 'auto-fix stopped: x');
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'auto-fix stopped: x', runAt: 'x', gates: [] });
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
    expect(stageBlock(store, id, 'ship')).not.toBeNull();
  });

  it('a failed action writes its own note body and does not set the budget-spent reason', async () => {
    seedPr(failing('build'));
    const r = rig({}, { kind: 'failed', reason: 'gh down' });
    await autopilotTick(r.deps);
    expect(r.notes[0]![1]).toBe('AP-1 (ci): the action failed (gh down); the ticket stays in ship and no attempt was used.');
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 ci: auto-fix stopped: ci could not run (gh down)');
  });

  it('never overwrites a foreign ship block that appears during a round', async () => {
    seedPr(failing('build'));
    const r = rig({
      sendCiFailure: async () => {
        parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'push-diverged', reason: 'push diverged', runAt: 'x', gates: [] });
        return { kind: 'failed', reason: 'gh down' };
      },
    });
    expect((await autopilotTick(r.deps)).kind).toBe('idle');
    expect(stageBlock(store, id, 'ship')).toMatchObject({ kind: 'push-diverged', reason: 'push diverged' });
    expect(r.notes).toEqual([]);
  });

  it('a full concurrency limit writes one exact note per signature and a debug line each tick', async () => {
    seedPr(failing('build'));
    const r = rig({ concurrencyFull: () => true });
    await autopilotTick(r.deps);
    await autopilotTick(r.deps);
    expect(r.notes).toEqual([['Autopilot: ci round is waiting', 'AP-1: the ci round for r waits for a free sub-task slot; it starts when one is free.']]);
    expect(r.debug).toHaveBeenCalledTimes(2);
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 ci round for r is waiting for a free concurrency slot');
  });

  it('parks when the stored failing list is cut short, because a hidden check may not be on the allowlist', async () => {
    seedPr({ ...failing('build'), failed: 3, failedShown: 1 });
    const r = rig();
    const result = await autopilotTick(r.deps);
    expect(result).toEqual({ kind: 'parked', reason: 'auto-fix not run: the list of failing ci checks is cut short' });
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
  });

  it('with two failing PRs every PR spends its own attempt', async () => {
    seedPr(failing('build'));
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r2', '/w/r2', 'b');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'r2', 6, 'https://github.com/o/r2/pull/6', 'open', JSON.stringify(failing('lint')));
    await autopilotTick(rig().deps);
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
    expect(getAutopilotBudget(store, id, 'r2', 'ci').attempts).toBe(1);
  });

  it('a spent budget on a later PR parks the round and gives back the attempts taken first', async () => {
    seedPr(failing('build'));
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r2', '/w/r2', 'b');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'r2', 6, 'https://github.com/o/r2/pull/6', 'open', JSON.stringify(failing('lint')));
    for (let i = 0; i < 3; i += 1) takeAutopilotAttempt(store, id, 'r2', 'ci', 'lint', 3);
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci 3/3' });
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
  });

  it('checks the allowlist on every failing PR, because the action sends them all', async () => {
    seedPr(failing('build'));
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r2', '/w/r2', 'b');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'r2', 6, 'https://github.com/o/r2/pull/6', 'open', JSON.stringify(failing('deploy')));
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix not run: ci check deploy is not on the allowlist' });
    expect(r.sendCi).not.toHaveBeenCalled();
  });

  it('parks a graph ticket with its own reason and uses no attempt', async () => {
    seedPr(failing('build'));
    const r = rig({ isGraphTicket: () => true });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix not run: graph ticket' });
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(r.notes[0]![0]).toBe('Autopilot: auto-fix not run: graph ticket');
    expect(r.notes[0]![1]).toContain('an active graph run owns the sessions of this ticket, so a hand-off would reach no agent. Retry when the run closes, or send the failure to the agent by hand.');
  });

  // T1158: a graph ticket whose runs are all closed (the seam reads false) is an ordinary ticket: the round goes out.
  it('sends a CI round to a graph ticket with no active graph run and spends one attempt', async () => {
    seedPr(failing('build'));
    const r = rig({ isGraphTicket: () => false });
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(r.sendCi).toHaveBeenCalledOnce();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
  });

  it('a second tick on an unchanged park does not report a new action', async () => {
    seedPr(failing('other-check'));
    expect((await autopilotTick(rig().deps)).kind).toBe('parked');
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
  });

  it('the budget-spent note says what to do', async () => {
    seedPr(failing('build'));
    await spend(3);
    const r = rig();
    await autopilotTick(r.deps);
    expect(r.notes[0]).toEqual(['Autopilot: auto-fix stopped: ci 3/3', 'AP-1 (ci): the budget for r is spent; approve one more attempt or fix it by hand.']);
  });

  it('approve-one-more and stop write exact notes and debug lines', async () => {
    const notes: Array<[string, string]> = [];
    const debug = vi.fn();
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: (t, b) => void notes.push([t, b]), debug }, 'r', 'ci');
    expect(notes[0]).toEqual(['Autopilot: one more ci attempt approved', 'AP-1: r now has 1 extra attempt(s) (0 used).']);
    expect(debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 ci +1 approved for r');
    const stopNotes: Array<[string, string]> = [];
    const stop = vi.fn(async () => true);
    const sd = { store, ticketId: id, key: 'AP-1', note: (t: string, b: string) => void stopNotes.push([t, b]), debug, stopSession: stop };
    await stopAutopilot(sd, 'after-round');
    await stopAutopilot(sd, 'now');
    expect(stopNotes).toEqual([
      ['Autopilot: stopped after this round', 'AP-1: a person stopped auto-fix after the current round.'],
      ['Autopilot: stopped now', 'AP-1: a person stopped auto-fix and ended the session.'],
    ]);
    expect(debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 stop after-round');
    expect(debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 stop now');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('amber Needs you state', () => {
  it('a park writes the ship block with the reason, and an approval clears it', async () => {
    seedPr(failing('build'));
    await spend(4);
    expect(stageBlock(store, id, 'ship')).toMatchObject({ kind: 'awaiting-merge', reason: 'auto-fix stopped: ci 3/3' });
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: () => {}, debug: () => {} }, 'r', 'ci');
    expect(stageBlock(store, id, 'ship')).toMatchObject({ kind: 'awaiting-merge', reason: expect.stringContaining('is not merged yet') });
  });

  it('never clears a block that autopilot did not write', async () => {
    seedPr();
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'waiting for review', runAt: 'x', gates: [] });
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: () => {}, debug: () => {} }, 'r', 'ci');
    expect(stageBlock(store, id, 'ship')?.reason).toBe('waiting for review');
  });
});

describe('autopilotTick guards', () => {
  it('is idle for a paused ticket', async () => {
    seedPr(failing('build'));
    pauseTicket(store, id);
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'idle' });
    expect(r.sendCi).not.toHaveBeenCalled();
  });

  it('is busy while the ship saga runs', async () => {
    seedPr(failing('build'));
    setStage(store, id, 'ship', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'busy' });
    expect(r.sendCi).not.toHaveBeenCalled();
  });

  it('clears the park block and the stop reason when the problem is gone', async () => {
    seedPr(failing('build'));
    await spend(4);
    expect(stageBlock(store, id, 'ship')?.reason).toMatch(/^auto-fix/);
    cleanMerge();
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify(PASSING), id);
    expect((await autopilotTick(rig().deps)).kind).toBe('cleared');
    expect(stageBlock(store, id, 'ship')).toMatchObject({ kind: 'awaiting-merge', reason: expect.stringContaining('is not merged yet') });
    expect(getAutopilotTicket(store, id).stoppedReason).toBeNull();
  });

  it('waits when one PR fails and another open PR has an unknown or missing CI status', async () => {
    for (const other of [undefined, { ...PASSING, state: 'unknown' }]) {
      store.db.prepare('DELETE FROM prs').run();
      seedPr(failing('build'));
      store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r2', '/w/r2', 'b');
      store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'r2', 6, 'https://github.com/o/r2/pull/6', 'open', other === undefined ? null : JSON.stringify(other));
      const r = rig();
      expect((await autopilotTick(r.deps)).kind).toBe('nothing');
      expect(r.sendCi).not.toHaveBeenCalled();
      store.db.prepare('DELETE FROM worktrees WHERE repo = ?').run('r2');
    }
  });

  it('waits while a failing rollup still has pending checks, because its failing list is partial', async () => {
    seedPr({ ...failing('build'), pending: 1 });
    const r = rig();
    expect((await autopilotTick(r.deps)).kind).toBe('nothing');
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
  });

  it('keeps the park when the CI status is unknown (no positive evidence)', async () => {
    seedPr(failing('build'));
    await spend(4);
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify({ ...PASSING, state: 'unknown' }), id);
    cleanMerge();
    await autopilotTick(rig().deps);
    expect(stageBlock(store, id, 'ship')?.reason).toMatch(/^auto-fix/);
    expect(getAutopilotTicket(store, id).stoppedReason).not.toBeNull();
  });

  it('keeps a block that autopilot did not write', async () => {
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'waiting for review', runAt: 'x', gates: [] });
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
    expect(stageBlock(store, id, 'ship')?.reason).toBe('waiting for review');
  });

  it('leaves a push-diverged block alone: no round, no park', async () => {
    seedPr(failing('build'));
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'push-diverged', reason: 'origin moved', runAt: '2026-01-01T00:00:00Z', gates: [] });
    const r = rig();
    expect((await autopilotTick(r.deps)).kind).toBe('idle');
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(stageBlock(store, id, 'ship')?.kind).toBe('push-diverged');
  });

  it('refuses a second tick while a round is in flight', async () => {
    seedPr(failing('build'));
    let release!: (o: FixOutcome) => void;
    let started!: () => void;
    const reached = new Promise<void>((res) => { started = res; });
    const first = rig({ sendCiFailure: () => new Promise<FixOutcome>((res) => { release = res; started(); }) });
    const p = autopilotTick(first.deps);
    await reached;
    expect((await autopilotTick(rig().deps)).kind).toBe('busy');
    release({ kind: 'sent' });
    expect((await p).kind).toBe('armed');
  });

  it('gives the attempt back and stays quiet when the lease is lost', async () => {
    seedPr(failing('build'));
    const r = rig({}, { kind: 'lease-lost' });
    expect((await autopilotTick(r.deps)).kind).toBe('not-controller');
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(stageBlock(store, id, 'ship')).toMatchObject({ kind: 'awaiting-merge', reason: NORMAL_BLOCK });
  });

  it('pauses with a visible reason and refunds the attempt when the ticket left ship before the launch failed', async () => {
    seedPr(failing('build'));
    const r = rig({ sendCiFailure: async () => { setStageCurrent(store, id, 'impl'); return { kind: 'failed', reason: 'no seat' }; } });
    const result = await autopilotTick(r.deps);
    expect(result.kind).toBe('parked');
    expect(stageBlock(store, id, 'ship')).toMatchObject({ kind: 'awaiting-merge', reason: NORMAL_BLOCK });
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(getAutopilotTicket(store, id).pausedReason).toBe('auto-fix paused: ci session did not start (no seat)');
    expect(r.notes.length).toBe(1);
  });

  it('shows a round that waits for the concurrency limit: one note per signature, a debug line per tick', async () => {
    seedPr(failing('build'));
    const r = rig({ concurrencyFull: () => true });
    expect((await autopilotTick(r.deps)).kind).toBe('queued');
    expect((await autopilotTick(r.deps)).kind).toBe('queued');
    expect(r.notes.length).toBe(1);
    expect(r.debug.mock.calls.filter(([m]) => String(m).includes('waiting for a free concurrency slot')).length).toBe(2);
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
  });
});

describe('conflicts', () => {
  const setBase = (repo: string, baseSha: string): void => {
    store.db.prepare('UPDATE merge_checks SET base_sha = ? WHERE ticket_id = ? AND repo = ?').run(baseSha, id, repo);
  };
  const spendRounds = async (n: number): Promise<void> => { for (let i = 0; i < n; i += 1) await autopilotTick(rig().deps); };

  it('sends a conflict round for a conflicted open PR, with one note and one attempt used', async () => {
    seedPr(PASSING);
    conflict();
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'armed', problem: 'conflicts', used: 1, max: 2 });
    expect(r.sendConflict).toHaveBeenCalledWith('r');
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(r.notes[0]![0]).toBe('Autopilot: conflicts round 1/2');
    expect(getAutopilotBudget(store, id, 'r', 'conflicts')).toMatchObject({ attempts: 1, signature: 'base1' });
  });

  it('honours the ask policy and stays a manual click when the base head is unknown', async () => {
    seedPr(PASSING);
    conflict();
    const ask = rig({ config: () => ({ ...CFG, conflicts: { policy: 'ask', maxRounds: 2 } }) });
    expect((await autopilotTick(ask.deps)).kind).toBe('nothing');
    expect(ask.sendConflict).not.toHaveBeenCalled();
    conflict('r', null);
    const unknown = rig();
    expect((await autopilotTick(unknown.deps)).kind).toBe('nothing');
    expect(unknown.sendConflict).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
  });

  it('parks with "auto-fix stopped: conflicts 2/2" once the budget is spent, with ONE note across repeat ticks', async () => {
    seedPr(PASSING);
    conflict();
    await spendRounds(2);
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: conflicts 2/2' });
    await autopilotTick(r.deps);
    expect(r.sendConflict).not.toHaveBeenCalled();
    expect(r.notes).toHaveLength(1);
    expect(stageBlock(store, id, 'ship')).toMatchObject({ reason: 'auto-fix stopped: conflicts 2/2' });
  });

  it('a new base head resets the counter; the same base head keeps counting', async () => {
    seedPr(PASSING);
    conflict();
    await spendRounds(2);
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(2);
    setBase('r', 'base2');
    expect(await autopilotTick(rig().deps)).toMatchObject({ kind: 'armed', used: 1, max: 2 });
    expect(getAutopilotBudget(store, id, 'r', 'conflicts')).toMatchObject({ attempts: 1, signature: 'base2' });
    expect(await autopilotTick(rig().deps)).toMatchObject({ kind: 'armed', used: 2 });
    expect((await autopilotTick(rig().deps)).kind).toBe('parked');
  });

  it('approve-one-more adds one conflict attempt and does not reset the counter', async () => {
    seedPr(PASSING);
    conflict();
    await spendRounds(2);
    await autopilotTick(rig().deps);
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: () => {}, debug: () => {} }, 'r', 'conflicts');
    expect(await autopilotTick(rig().deps)).toMatchObject({ kind: 'armed', used: 3, max: 3 });
    expect((await autopilotTick(rig().deps)).kind).toBe('parked');
  });

  it('starts no second round while the first round or its auto-deliver runs, even though the merge check is still conflicted', async () => {
    seedPr(PASSING);
    conflict();
    const r = rig({ conflictRoundActive: () => true });
    expect((await autopilotTick(r.deps)).kind).toBe('busy');
    expect(r.sendConflict).not.toHaveBeenCalled();
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
  });

  it('a sent round forgets the stale CI rollup, so no CI round starts on the old head', async () => {
    seedPr(failing('build'));
    conflict();
    const r = rig();
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    const row = store.db.prepare('SELECT checks FROM prs WHERE ticket_id = ?').get(id) as { checks: string | null };
    expect(row.checks).toBeNull();
    setMergeCheck(store, { ticketId: id, repo: 'r', state: 'clean', files: [], reason: null, headSha: 'h2', baseSha: 'base1', baseRef: 'develop', checkedAt: 'y' });
    expect((await autopilotTick(rig().deps)).kind).not.toBe('armed');
    expect(r.sendCi).not.toHaveBeenCalled();
  });

  it('a spent budget on one repo does not stop auto-fix for a second conflicted repo', async () => {
    seedPr(PASSING);
    conflict('a-repo');
    conflict('r');
    takeAutopilotAttempt(store, id, 'a-repo', 'conflicts', 'base1', 2);
    takeAutopilotAttempt(store, id, 'a-repo', 'conflicts', 'base1', 2);
    const r = rig();
    expect(await autopilotTick(r.deps)).toMatchObject({ kind: 'armed', problem: 'conflicts', used: 1 });
    expect(r.sendConflict).toHaveBeenCalledWith('r');
    expect(r.sendConflict).not.toHaveBeenCalledWith('a-repo');
    expect(stageBlock(store, id, 'ship')?.reason).toBe(NORMAL_BLOCK);
  });

  it('parks only when every conflicted repo is spent', async () => {
    seedPr(PASSING);
    conflict('a-repo');
    conflict('r');
    for (const repo of ['a-repo', 'r']) { takeAutopilotAttempt(store, id, repo, 'conflicts', 'base1', 2); takeAutopilotAttempt(store, id, repo, 'conflicts', 'base1', 2); }
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: conflicts 2/2' });
    expect(r.sendConflict).not.toHaveBeenCalled();
  });

  it('parks an unknown placement as for CI and uses no attempt', async () => {
    seedPr(PASSING);
    conflict();
    const r = rig({ placement: async () => { throw new Error('none'); } });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix not run: placement unknown' });
    expect(r.sendConflict).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
  });

  // T1286: the graph run records the host placement when it starts, so a graph ticket that reached ship after its run
  // closed starts the conflicts round instead of parking placement-unknown.
  it('a graph ticket whose run recorded host placement starts the conflicts round', async () => {
    seedPr(PASSING);
    conflict();
    store.db.prepare("UPDATE tickets SET approach = 'karst-graph-engineering' WHERE id = ?").run(id);
    createGraphRun(store.db, { ticketId: id, stageAttempt: 0, approachId: 'karst-graph-engineering', now: '2026-11-21T00:00:00.000Z' });
    store.db.prepare("UPDATE approach_graph_runs SET status = 'closed' WHERE ticket_id = ?").run(id);
    recordPlacementIfAbsent(store, id, GRAPH_RUN_PLACEMENT);
    expect(getPlacement(store, id)).toEqual(GRAPH_RUN_PLACEMENT);
    const placement = makePlacementCheck((ticketId) => getPlacement(store, ticketId));
    const r = rig({ placement: () => placement(id) });
    expect(await autopilotTick(r.deps)).toMatchObject({ kind: 'armed', problem: 'conflicts' });
    expect(r.sendConflict).toHaveBeenCalledWith('r');
  });

  it('waits for a free concurrency slot and uses no attempt', async () => {
    seedPr(PASSING);
    conflict();
    const r = rig({ concurrencyFull: () => true });
    expect((await autopilotTick(r.deps)).kind).toBe('queued');
    expect(r.sendConflict).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
  });

  it('drops the armed conflict round when the round fails, so a later manual session gets no auto-delivery', async () => {
    seedPr(PASSING);
    conflict();
    const drop = vi.fn();
    const failed = rig({ dropConflictRound: drop }, { kind: 'failed', reason: 'probe failed' });
    await autopilotTick(failed.deps);
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it('refunds the attempt and parks when the round fails or throws; a lost lease refunds quietly', async () => {
    seedPr(PASSING);
    conflict();
    const failed = rig({}, { kind: 'failed', reason: 'probe failed' });
    expect(await autopilotTick(failed.deps)).toMatchObject({ kind: 'parked', reason: 'auto-fix stopped: conflicts could not run (probe failed)' });
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
    setAutopilotOverride(store, id, 'on');
    const thrown = rig();
    thrown.sendConflict.mockRejectedValueOnce(new Error('boom'));
    expect(await autopilotTick(thrown.deps)).toMatchObject({ kind: 'parked', reason: 'auto-fix stopped: conflicts could not run (boom)' });
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
    setAutopilotOverride(store, id, 'on');
    const lost = rig({}, { kind: 'lease-lost' });
    expect((await autopilotTick(lost.deps)).kind).toBe('not-controller');
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
  });

  it('parks and drops a stalled round, so a stale CI rollup of the old head starts no round', async () => {
    seedPr(failing('build'));
    conflict();
    markConflictRound(store, id, Date.now());
    const drop = vi.fn();
    const r = rig({ conflictRoundStalled: () => true, conflictRoundActive: () => true, dropConflictRound: drop });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: conflict round did not deliver' });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(r.sendConflict).not.toHaveBeenCalled();
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(store.db.prepare('SELECT conflict_round_at AS at FROM autopilot_tickets WHERE ticket_id = ?').get(id)).toEqual({ at: null });
    // The park holds on the next ticks: the probe reads the local merge commit as clean, the CI rollup is of the old head.
    setMergeCheck(store, { ticketId: id, repo: 'r', state: 'clean', files: [], reason: null, headSha: 'h', baseSha: 'base1', baseRef: 'develop', checkedAt: 'x' });
    const next = rig();
    expect((await autopilotTick(next.deps)).kind).toBe('idle');
    expect(next.sendCi).not.toHaveBeenCalled();
    // A person approves one more attempt: the engine works again.
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: () => {}, debug: () => {} }, 'r', 'conflicts');
    expect((await autopilotTick(rig().deps)).kind).not.toBe('idle');
  });

  it('does not drop the round of a manual Resolve conflicts click (no engine mark)', async () => {
    seedPr(PASSING);
    conflict();
    const drop = vi.fn();
    const r = rig({ conflictRoundStalled: () => true, conflictRoundActive: () => true, dropConflictRound: drop });
    expect((await autopilotTick(r.deps)).kind).toBe('busy');
    expect(drop).not.toHaveBeenCalled();
  });

  // T1315: the merge is finished and correct; only a gate (or the base check) stopped the push. The agent is already idle,
  // so no Stop ever retries it, and the stall rule would drop a merge that is ready to deliver.
  describe('a refused auto-deliver of a verified merge (T1315)', () => {
    const SHA = '2cc2990' + 'a'.repeat(33);
    const REFUSED = 'auto-fix stopped: resolved merge not delivered: gate "unit" failed';

    function refused(sha: string | null = SHA) {
      return rig({
        conflictRoundActive: () => true,
        conflictRoundStalled: () => false,
        conflictRoundRefused: () => ({ repo: 'r', tail: 'gate "unit" failed', sha, runId: null, baseRef: null, baseSha: null }),
        dropConflictRound: vi.fn(),
      });
    }

    it('parks at once with the gate named and the merge commit in the body', async () => {
      seedPr(failing('build'));
      conflict();
      markConflictRound(store, id, Date.now());
      const r = refused();
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: REFUSED });
      expect(r.deps.dropConflictRound).toHaveBeenCalledTimes(1);
      expect(store.db.prepare('SELECT conflict_round_at AS at FROM autopilot_tickets WHERE ticket_id = ?').get(id)).toEqual({ at: null });
      const [title, body] = r.notes[r.notes.length - 1]!;
      expect(title).toBe(`Autopilot: ${REFUSED}`);
      expect(body).toMatch(/^AP-1 \(conflicts\): /);
      expect(body).toContain('the merge commit 2cc2990');
      expect(body).toContain('is ready in the worktree of r');
      expect(body).toContain('the manual Deliver pushes it');
      expect(stageBlock(store, id, 'ship')?.reason).toBe(REFUSED);
      // A park, not a pause: the person may still approve one more attempt.
      expect(getAutopilotTicket(store, id).pausedReason).toBeNull();
      expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: the resolved merge was not delivered (gate "unit" failed); the round is dropped');
      expect(r.sendCi).not.toHaveBeenCalled();
      // The park holds on the next ticks: nothing retries a delivery the agent is already idle for.
      const next = rig({ conflictRoundActive: () => false });
      expect((await autopilotTick(next.deps)).kind).toBe('idle');
      expect(next.sendCi).not.toHaveBeenCalled();
    });

    it('names no sha when git could not read the merge commit', async () => {
      seedPr(failing('build'));
      conflict();
      markConflictRound(store, id, Date.now());
      const r = refused(null);
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: REFUSED });
      expect(r.notes[r.notes.length - 1]![1]).toContain('the resolved merge is ready in the worktree of r');
    });

    it('reads the refusal the delivery recorded on the process rounds when no seam is given', async () => {
      seedPr(failing('build'));
      conflict();
      markConflictRound(store, id, Date.now());
      conflictRounds.arm(id, { repo: 'r', baseSha: 'base1', files: ['a.ts'] });
      conflictRounds.refuse(id, { repo: 'r', tail: 'gate "unit" failed', sha: SHA, runId: null, baseRef: null, baseSha: null });
      try {
        expect(await autopilotTick(rig().deps)).toEqual({ kind: 'parked', reason: REFUSED });
      } finally {
        conflictRounds.disarm(id);
      }
    });

    it('keeps the stall path and UNFINISHED_BODY for an unfinished merge', async () => {
      seedPr(failing('build'));
      conflict();
      markConflictRound(store, id, Date.now());
      const drop = vi.fn();
      const r = rig({ conflictRoundActive: () => true, conflictRoundStalled: () => true, conflictRoundRefused: () => null, dropConflictRound: drop });
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: conflict round did not deliver' });
      expect(drop).toHaveBeenCalledTimes(1);
      expect(r.notes[r.notes.length - 1]![1]).toBe(`AP-1 (conflicts): ${UNFINISHED_BODY}`);
    });

    it('does not park the round of a manual Resolve conflicts click on a refusal', async () => {
      seedPr(PASSING);
      conflict();
      const drop = vi.fn();
      const r = rig({
        conflictRoundActive: () => true,
        conflictRoundRefused: () => ({ repo: 'r', tail: 'gate "unit" failed', sha: null, runId: null, baseRef: null, baseSha: null }),
        dropConflictRound: drop,
      });
      expect((await autopilotTick(r.deps)).kind).toBe('busy');
      expect(drop).not.toHaveBeenCalled();
      expect(r.notes).toEqual([]);
    });
  });

  // T1381: a refusal whose deliver run has a gate that exited non-zero starts a gate fix round in the same tick instead
  // of parking for a manual Deliver; a refusal with no failed gate keeps the T1315 park.
  describe('a refused auto-deliver whose run failed a gate (T1381)', () => {
    const SHA = '2cc2990' + 'a'.repeat(33);
    const REFUSED = 'auto-fix stopped: resolved merge not delivered: gate "unit" failed';

    function failedRun(kind: 'auto' | 'base-moved' = 'auto', head: string | null = 'head1', exit: number | null = 1, repo = 'r', gate = 'unit'): number {
      const runId = openDeliverRun(store, { ticketId: id, headSha: head, gates: [gate], pid: 1, now: 'T0', kind });
      recordDeliverGate(store, runId, { gateName: gate, repo, exitCode: exit, summary: 'FAIL a.test.ts', startedAt: null, endedAt: null });
      finishDeliverRun(store, runId, 'failed', 'T1');
      return runId;
    }

    function refusal(runId: number | null, over: Partial<{ sha: string | null; baseRef: string | null; baseSha: string | null; tail: string }> = {}) {
      return { repo: 'r', tail: 'gate "unit" failed', sha: SHA, runId, baseRef: 'develop', baseSha: 'base1', ...over };
    }

    function rigRefused(runId: number | null, over: Partial<AutopilotDeps> = {}, send: FixOutcome = { kind: 'sent' }) {
      const sendRefusedMergeFailure = vi.fn(async (_state: BaseMovedFailureState) => send);
      return {
        ...rig({
          conflictRoundActive: () => true,
          conflictRoundStalled: () => false,
          conflictRoundRefused: () => refusal(runId),
          sendRefusedMergeFailure,
          dropConflictRound: vi.fn(),
          ...over,
        }),
        sendRefusedMergeFailure,
      };
    }

    it('(a) starts one ci gate fix round for a failed auto run with a non-zero gate', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', 'head1');
      const r = rigRefused(runId);
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
      expect(r.sendRefusedMergeFailure).toHaveBeenCalledOnce();
      expect(r.sendCi).not.toHaveBeenCalled();
      expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
      expect(getCiRoundAt(store, id)).not.toBeNull();
      expect(getCiRoundHeadSha(store, id, 'r')).toBe('head1');
      expect(r.deps.dropConflictRound).toHaveBeenCalledTimes(1);
      expect(store.db.prepare('SELECT conflict_round_at AS at FROM autopilot_tickets WHERE ticket_id = ?').get(id)).toEqual({ at: null });
      expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: the resolved merge failed gate unit; the gate fix round is armed');
      expect(getAutopilotTicket(store, id).stoppedReason).toBeNull();      expect(stageBlock(store, id, 'ship')?.reason).toBe(NORMAL_BLOCK);
      expect(r.notes[r.notes.length - 1]![0]).toBe('Autopilot: ci round 1/3');
      // The guard is store state: a reload or another window reads it, not this process's memory (v140).
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
      expect(r.deps.dropConflictRound).toHaveBeenCalledOnce();
    });

    it('(b) starts the round for a failed base-moved run', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('base-moved', 'head1');
      const r = rigRefused(runId);
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
      expect(r.sendRefusedMergeFailure).toHaveBeenCalledOnce();
      expect(getCiRoundHeadSha(store, id, 'r')).toBe('head1');
    });

    it('(c) keeps the refused-merge park when the run has no gate that exited non-zero', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', 'head1', null);
      const r = rigRefused(runId);
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: REFUSED });
      expect(r.sendRefusedMergeFailure).not.toHaveBeenCalled();
      expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
      expect(stageBlock(store, id, 'ship')?.reason).toBe(REFUSED);
      // A run with no non-zero gate must not even announce a gate fix round.
      expect(r.debug.mock.calls.some((call) => String(call[0]).includes('the gate fix round is armed'))).toBe(false);
      expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: the resolved merge was not delivered (gate "unit" failed); the round is dropped');
      expect(r.deps.dropConflictRound).toHaveBeenCalledOnce();
    });

    it('(d) honours the ask policy, spends no budget and writes no park', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', 'head1');
      const r = rigRefused(runId, { config: () => ({ ...CFG, ci: { ...CFG.ci, policy: 'ask' } }) });
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'ask', reason: 'ci policy is ask' });
      expect(r.sendRefusedMergeFailure).not.toHaveBeenCalled();
      expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
      expect(getAutopilotTicket(store, id).stoppedReason).toBeNull();
      // The ask policy ends the refusal's round (a person decides); the guard keeps the merge undelivered.
      expect(r.deps.dropConflictRound).toHaveBeenCalledOnce();
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
      // Nothing was armed, so the repair must not announce a sent round on every tick.
      expect(r.debug.mock.calls.some((call) => String(call[0]).includes('the gate fix round is armed'))).toBe(false);
    });

    it('(e) parks with the spent ci budget and refunds an earlier repo attempt of a multi-repo failure', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = openDeliverRun(store, { ticketId: id, headSha: 'head1', gates: ['unit'], pid: 1, now: 'T0', kind: 'auto' });
      recordDeliverGate(store, runId, { gateName: 'unit', repo: 'a', exitCode: 1, summary: 'FAIL a', startedAt: null, endedAt: null });
      recordDeliverGate(store, runId, { gateName: 'unit', repo: 'b', exitCode: 1, summary: 'FAIL b', startedAt: null, endedAt: null });
      finishDeliverRun(store, runId, 'failed', 'T1');
      const state = deliverRunFailureState(store, id, runId, 'develop', 'base1');
      if (!state.available) throw new Error('the run should be readable');
      for (let i = 0; i < 3; i += 1) takeAutopilotAttempt(store, id, 'b', 'ci', state.reason, 3);
      const r = rigRefused(runId);
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci 3/3' });
      expect(r.sendRefusedMergeFailure).not.toHaveBeenCalled();
      // a's attempt was taken first and given back when b's budget was spent.
      expect(getAutopilotBudget(store, id, 'a', 'ci').attempts).toBe(0);
      expect(getAutopilotBudget(store, id, 'b', 'ci').attempts).toBe(3);
      // A park ends the refusal's round; the guard keeps the merge undelivered while a person decides.
      expect(r.deps.dropConflictRound).toHaveBeenCalledOnce();
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
    });

    it('(f) parks with the no-change reason on a second refusal at the same head', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      await autopilotTick(rigRefused(failedRun('auto', 'head1')).deps);
      // The fix round came back: the deliver run refused again on the SAME ticket head.
      markConflictRound(store, id, Date.now());
      const second = rigRefused(failedRun('auto', 'head1'));
      expect(await autopilotTick(second.deps)).toEqual({ kind: 'parked', reason: NO_CHANGE_BASE_MOVED_REASON });
      expect(second.sendRefusedMergeFailure).not.toHaveBeenCalled();
      expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
    });

    it('(g) keeps today\'s refused-merge park when the send seam is absent', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', 'head1');
      const r = rig({
        conflictRoundActive: () => true,
        conflictRoundRefused: () => refusal(runId),
        dropConflictRound: vi.fn(),
      });
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: REFUSED });
      expect(stageBlock(store, id, 'ship')?.reason).toBe(REFUSED);
      expect(r.deps.dropConflictRound).toHaveBeenCalledOnce();
    });

    it('(h) retries the ask decision after a reload and resumes once the head moves', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const resumeDeliver = vi.fn(async () => 'started' as const);
      let head = SHA;
      const askCfg = { ...CFG, ci: { ...CFG.ci, policy: 'ask' as const } };
      // The ask policy stops the round without arming: the merge stays at HEAD and the guard is recorded.
      const first = rigRefused(failedRun('auto', 'head1'), { config: () => askCfg, resumeDeliver, localHead: async () => head });
      expect((await autopilotTick(first.deps)).kind).toBe('ask');
      const later = (): ReturnType<typeof rig> => rig({
        config: () => askCfg,
        resumeDeliver,
        localHead: async () => head,
        conflictRoundActive: () => false,
        conflictRoundRefused: () => null,
        sendRefusedMergeFailure: vi.fn(async () => ({ kind: 'sent' as const })),
      });
      // The store guard retries the ask instead of delivering the refused merge, and no round starts on the stale head.
      const blocked = later();
      expect((await autopilotTick(blocked.deps)).kind).toBe('ask');
      expect(resumeDeliver).not.toHaveBeenCalled();
      expect(blocked.sendCi).not.toHaveBeenCalled();
      expect(blocked.sendConflict).not.toHaveBeenCalled();
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
      // The agent's fix made a new commit: the guard clears and the finished merge is resumed.
      head = 'b'.repeat(40);
      expect((await autopilotTick(later().deps)).kind).toBe('busy');
      expect(resumeDeliver).toHaveBeenCalledWith(false);
      expect(getRefusedMerge(store, id)).toBeNull();
    });

    it('(h) also guards the resume after a spent budget', async () => {
      seedPr(PASSING);
      conflict();
      for (let i = 0; i < 3; i += 1) {
        markConflictRound(store, id, Date.now());
        await autopilotTick(rigRefused(failedRun('auto', `h${i}`)).deps);
      }
      expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(3);
      const resumeDeliver = vi.fn(async () => 'started' as const);
      markConflictRound(store, id, Date.now());
      const stopped = rigRefused(failedRun('auto', 'h4'), { resumeDeliver, localHead: async () => SHA });
      expect((await autopilotTick(stopped.deps)).kind).toBe('parked');
      const next = rig({ resumeDeliver, localHead: async () => SHA, conflictRoundActive: () => false, conflictRoundRefused: () => null });
      await autopilotTick(next.deps);
      expect(resumeDeliver).not.toHaveBeenCalled();
    });

    it('(i) passes a failure state whose reason names the ticket base ref', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', 'head1');
      const r = rigRefused(runId);
      await autopilotTick(r.deps);
      const state = r.sendRefusedMergeFailure.mock.calls[0]![0];
      expect(state.available).toBe(true);
      expect(baseRefOf(state.reason)).toBe('develop');
    });

    it('(j) names every distinct failed gate once in the debug line', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = openDeliverRun(store, { ticketId: id, headSha: 'head1', gates: ['unit', 'lint', 'unit'], pid: 1, now: 'T0', kind: 'auto' });
      recordDeliverGate(store, runId, { gateName: 'unit', repo: 'r', exitCode: 1, summary: 'FAIL a.test.ts', startedAt: null, endedAt: null });
      recordDeliverGate(store, runId, { gateName: 'lint', repo: 'r', exitCode: 1, summary: 'FAIL b.test.ts', startedAt: null, endedAt: null });
      recordDeliverGate(store, runId, { gateName: 'unit', repo: 'r', exitCode: 1, summary: 'FAIL c.test.ts', startedAt: null, endedAt: null });
      finishDeliverRun(store, runId, 'failed', 'T1');
      const r = rigRefused(runId);
      await autopilotTick(r.deps);
      expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: the resolved merge failed gate unit, lint; the gate fix round is armed');
    });

    it('(k) keeps the park and says so when the refusal names no deliver run', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const r = rigRefused(null);
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: REFUSED });
      expect(r.sendRefusedMergeFailure).not.toHaveBeenCalled();
      expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: the refusal named no deliver run; the round is dropped');
      expect(getRefusedMerge(store, id)).toBeNull();
    });

    it('(l) records no refused head when neither the merge nor the run has a sha, so a reload still delivers', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', null);
      const first = rigRefused(runId, { conflictRoundRefused: () => refusal(runId, { sha: null }) });
      expect(await autopilotTick(first.deps)).toMatchObject({ kind: 'armed', problem: 'ci' });
      // No merge sha anywhere: no half-written guard row either.
      expect(store.db.prepare('SELECT refused_merge_repo AS repo, refused_merge_sha AS sha FROM autopilot_tickets WHERE ticket_id = ?').get(id)).toEqual({ repo: null, sha: null });
      const resumeDeliver = vi.fn(async () => 'started' as const);
      const later = rig({ resumeDeliver, localHead: async () => null, conflictRoundRefused: () => null });
      expect((await autopilotTick(later.deps)).kind).toBe('busy');
      expect(resumeDeliver).toHaveBeenCalledWith(false);
    });

    it('(l2) records the run head when the merge sha is unknown, so a reload still guards it', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', 'head1');
      const first = rigRefused(runId, { conflictRoundRefused: () => refusal(runId, { sha: null }) });
      expect(await autopilotTick(first.deps)).toMatchObject({ kind: 'armed', problem: 'ci' });
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: 'head1' });
      // A reload: the run's head is still at HEAD, so the refused merge is not delivered.
      const resumeDeliver = vi.fn(async () => 'started' as const);
      const later = rig({ resumeDeliver, localHead: async () => 'head1', conflictRoundRefused: () => null, sendRefusedMergeFailure: vi.fn(async () => ({ kind: 'sent' as const })) });
      await autopilotTick(later.deps);
      expect(resumeDeliver).not.toHaveBeenCalled();
    });

    it('(m) a dead round slot never bypasses the guard, and a moved head resumes', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      expect((await autopilotTick(rigRefused(failedRun('auto', 'head1')).deps)).kind).toBe('armed');
      // The reload left the round's slot in the store: the repair frees it and waits (the round already ran at this head).
      markConflictRound(store, id, Date.now());
      const resumeDeliver = vi.fn(async () => 'started' as const);
      const reload = rig({ resumeDeliver, localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: vi.fn(async () => ({ kind: 'sent' as const })) });
      expect((await autopilotTick(reload.deps)).kind).toBe('busy');
      expect(resumeDeliver).not.toHaveBeenCalled();
      expect(getConflictRoundAt(store, id)).toBeNull();
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
      // The agent's fix moved the head: the guard clears and the fixed merge is delivered.
      const fixed = rig({ resumeDeliver, localHead: async () => 'b'.repeat(40), conflictRoundRefused: () => null });
      expect((await autopilotTick(fixed.deps)).kind).toBe('busy');
      expect(resumeDeliver).toHaveBeenCalledWith(false);
      expect(fixed.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: the fix moved the local head; the refused-merge guard is cleared');
      expect(getRefusedMerge(store, id)).toBeNull();
    });

    it('(n) does not resume when the local head cannot be read', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const first = rigRefused(failedRun('auto', 'head1'), { config: () => ({ ...CFG, ci: { ...CFG.ci, policy: 'ask' } }) });
      expect((await autopilotTick(first.deps)).kind).toBe('ask');
      const resumeDeliver = vi.fn(async () => 'started' as const);
      const later = rig({
        resumeDeliver, localHead: async () => { throw new Error('git failed'); }, conflictRoundRefused: () => null,
        sendRefusedMergeFailure: vi.fn(async () => ({ kind: 'sent' as const })),
      });
      expect((await autopilotTick(later.deps)).kind).toBe('busy');
      expect(resumeDeliver).not.toHaveBeenCalled();
    });

    it('(o) does not resume while the local head is unknown (null)', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const first = rigRefused(failedRun('auto', 'head1'), { config: () => ({ ...CFG, ci: { ...CFG.ci, policy: 'ask' } }) });
      expect((await autopilotTick(first.deps)).kind).toBe('ask');
      const resumeDeliver = vi.fn(async () => 'started' as const);
      const later = rig({ resumeDeliver, localHead: async () => null, conflictRoundRefused: () => null, sendRefusedMergeFailure: vi.fn(async () => ({ kind: 'sent' as const })) });
      expect((await autopilotTick(later.deps)).kind).toBe('busy');
      expect(resumeDeliver).not.toHaveBeenCalled();
    });

    it('(p) clears the guard once the head moved, so a later head that matches it does not block again', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const first = rigRefused(failedRun('auto', 'head1'), { config: () => ({ ...CFG, ci: { ...CFG.ci, policy: 'ask' } }) });
      expect((await autopilotTick(first.deps)).kind).toBe('ask');
      const resumeDeliver = vi.fn(async () => 'started' as const);
      let head: string | null = 'moved';
      const tick = (): Promise<string> => autopilotTick(rig({ resumeDeliver, localHead: async () => head, conflictRoundRefused: () => null }).deps).then((r) => r.kind);
      expect(await tick()).toBe('busy');
      expect(getRefusedMerge(store, id)).toBeNull();
      resumeDeliver.mockClear();
      head = SHA;
      expect(await tick()).toBe('busy');
      expect(resumeDeliver).toHaveBeenCalledWith(false);
    });

    it('(q) clears the guard when the refused merge was delivered, so a stalled ticket never wedges', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      expect((await autopilotTick(rigRefused(failedRun('auto', 'head1')).deps)).kind).toBe('armed');
      // A person's manual Deliver pushed the refused merge: the PR head is that sha now.
      store.db.prepare('UPDATE prs SET head_oid = ? WHERE ticket_id = ?').run(SHA, id);
      const resumeDeliver = vi.fn(async () => 'started' as const);
      const delivered = rig({ resumeDeliver, localHead: async () => SHA, conflictRoundRefused: () => null });
      expect((await autopilotTick(delivered.deps)).kind).toBe('busy');
      expect(resumeDeliver).toHaveBeenCalledWith(false);
      expect(delivered.debug).toHaveBeenCalledWith(`[ship] autopilot ticket AP-1: the refused merge ${SHA.slice(0, 9)} was delivered; the guard is cleared`);
      expect(getRefusedMerge(store, id)).toBeNull();
    });

    it('(q2) clears the guard when the PR merged', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      expect((await autopilotTick(rigRefused(failedRun('auto', 'head1')).deps)).kind).toBe('armed');
      store.db.prepare("UPDATE prs SET status = 'merged' WHERE ticket_id = ?").run(id);
      // No local head seam: the merged PR alone clears the guard before any head read.
      const merged = rig({ conflictRoundRefused: () => null });
      await autopilotTick(merged.deps);
      expect(getRefusedMerge(store, id)).toBeNull();
    });

    it('(r) says the armed-round wait again after a refusal dropped the round', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const debug = vi.fn();
      const armedLine = '[ship] autopilot ticket AP-1: no round, a conflict round is armed or its resolved merge is being delivered';
      expect((await autopilotTick(rig({ conflictRoundActive: () => true, conflictRoundRefused: () => null, debug }).deps)).kind).toBe('busy');
      // The refusal drops the round and must forget that the wait was already said.
      const ask = rigRefused(failedRun('auto', 'head1'), { config: () => ({ ...CFG, ci: { ...CFG.ci, policy: 'ask' } }), debug });
      expect((await autopilotTick(ask.deps)).kind).toBe('ask');
      // The fix moved the head: the guard clears without reaching the armed-round note.
      await autopilotTick(rig({ resumeDeliver: async () => 'started' as const, localHead: async () => 'b'.repeat(40), conflictRoundRefused: () => null, debug }).deps);
      expect((await autopilotTick(rig({ conflictRoundActive: () => true, conflictRoundRefused: () => null, debug }).deps)).kind).toBe('busy');
      expect(debug.mock.calls.filter((call) => call[0] === armedLine)).toHaveLength(2);
    });

    it('(s) a queued gate fix round is retried from the store on the next tick', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', 'head1');
      const queued = rigRefused(runId, { concurrencyFull: () => true });
      expect(await autopilotTick(queued.deps)).toEqual({ kind: 'queued' });
      expect(queued.sendRefusedMergeFailure).not.toHaveBeenCalled();
      // The refusal's round ends at once; the retry state (run and merge) is in the store, not the round.
      expect(queued.deps.dropConflictRound).toHaveBeenCalledOnce();
      expect(getConflictRoundAt(store, id)).toBeNull();
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA, runId });
      // The slot frees: the next tick reads the store and sends, so a reload or a lost lease cannot lose the round.
      const sent = vi.fn(async () => ({ kind: 'sent' as const }));
      const retried = rig({ localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: sent });
      expect(await autopilotTick(retried.deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
      expect(sent).toHaveBeenCalledOnce();
      expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
    });

    it('(t) a lease-lost gate fix round is retried from the store on the next tick', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', 'head1');
      const lost = rigRefused(runId, {}, { kind: 'lease-lost' });
      expect(await autopilotTick(lost.deps)).toEqual({ kind: 'not-controller' });
      expect(lost.sendRefusedMergeFailure).toHaveBeenCalledOnce();
      expect(lost.deps.dropConflictRound).toHaveBeenCalledOnce();
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA, runId });
      expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
      const retried = rig({ localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: vi.fn(async () => ({ kind: 'sent' as const })) });
      expect(await autopilotTick(retried.deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
      expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
    });

    it('(u) a reload after a sent round waits for the fix and never re-delivers the merge', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      expect((await autopilotTick(rigRefused(failedRun('auto', 'head1')).deps)).kind).toBe('armed');
      const resumeDeliver = vi.fn(async () => 'started' as const);
      const sent = vi.fn(async () => ({ kind: 'sent' as const }));
      const reload = rig({ resumeDeliver, localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: sent, dropConflictRound: vi.fn() });
      expect((await autopilotTick(reload.deps)).kind).toBe('busy');
      expect(resumeDeliver).not.toHaveBeenCalled();
      // The repair does not end a round it never owned: only a fresh refusal drops one.
      expect(reload.deps.dropConflictRound).not.toHaveBeenCalled();
      // A round that already ran at this head is never re-sent.
      expect(sent).not.toHaveBeenCalled();
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
      // The fix moved the head: the guard clears and the finished merge is delivered.
      const fixed = rig({ resumeDeliver, localHead: async () => 'b'.repeat(40), conflictRoundRefused: () => null });
      expect((await autopilotTick(fixed.deps)).kind).toBe('busy');
      expect(resumeDeliver).toHaveBeenCalledWith(false);
      expect(getRefusedMerge(store, id)).toBeNull();
    });

    it('(v) a guard with no local-head seam stops the tick instead of guessing the head', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      expect((await autopilotTick(rigRefused(failedRun('auto', 'head1')).deps)).kind).toBe('armed');
      const later = rig({ conflictRoundActive: () => false, conflictRoundRefused: () => null, sendRefusedMergeFailure: vi.fn(async () => ({ kind: 'sent' as const })) });
      expect((await autopilotTick(later.deps)).kind).toBe('busy');
      expect(later.sendCi).not.toHaveBeenCalled();
      expect(later.sendConflict).not.toHaveBeenCalled();
    });

    it('(w) a stored guard whose run is gone surfaces the fallback park instead of waiting in silence', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', 'head1');
      // The queued round ends; the run row is gone by the time the reload repairs it.
      const queued = rigRefused(runId, { concurrencyFull: () => true });
      expect(await autopilotTick(queued.deps)).toEqual({ kind: 'queued' });
      store.db.prepare('DELETE FROM deliver_runs WHERE id = ?').run(runId);
      const resumeDeliver = vi.fn(async () => 'started' as const);
      const reload = rig({ resumeDeliver, localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: vi.fn(async () => ({ kind: 'sent' as const })) });
      expect(await autopilotTick(reload.deps)).toEqual({ kind: 'parked', reason: REFUSED });
      expect(resumeDeliver).not.toHaveBeenCalled();
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
    });

    it('(x) a round that ends from observed state clears the guard too', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const ask = rigRefused(failedRun('auto', 'head1'), { config: () => ({ ...CFG, ci: { ...CFG.ci, policy: 'ask' } }) });
      expect((await autopilotTick(ask.deps)).kind).toBe('ask');
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
      const rounds = createConflictRounds();
      rounds.arm(id, { repo: 'r', baseSha: 'base1', files: ['a.ts'] });
      const r = rig({
        conflictRoundActive: () => rounds.armed(id) !== null,
        conflictRoundEnded: async () => true,
        dropConflictRound: vi.fn(() => rounds.disarm(id)),
      });
      await autopilotTick(r.deps);
      expect(getRefusedMerge(store, id)).toBeNull();
    });

    it('(y) an armed round owns the guard: the repair waits instead of sending', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      // The first send is queued, so the stored repair has a run that was never sent.
      expect((await autopilotTick(rigRefused(failedRun('auto', 'head1'), { concurrencyFull: () => true }).deps)).kind).toBe('queued');
      const sent = vi.fn(async () => ({ kind: 'sent' as const }));
      const armed = rig({ conflictRoundActive: () => true, conflictRoundRefused: () => null, localHead: async () => SHA, sendRefusedMergeFailure: sent });
      expect((await autopilotTick(armed.deps)).kind).toBe('busy');
      expect(sent).not.toHaveBeenCalled();
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
    });

    it('(z1) the delivered check reads the guard repo, never another PR of the ticket', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      expect((await autopilotTick(rigRefused(failedRun('auto', 'head1')).deps)).kind).toBe('armed');
      store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'aa', '/w/aa', 'b');
      // A repo that sorts BEFORE the guard's own, closed: a find() that ignores the repo would answer with it.
      store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)').run(id, 'aa', 1, 'https://github.com/o/aa/pull/1', 'closed');
      const reload = rig({ localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: vi.fn(async () => ({ kind: 'sent' as const })) });
      expect((await autopilotTick(reload.deps)).kind).toBe('busy');
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
    });

    it('(z2) no PR row for the guard repo leaves the guard and stops the tick', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      expect((await autopilotTick(rigRefused(failedRun('auto', 'head1')).deps)).kind).toBe('armed');
      store.db.prepare('DELETE FROM prs').run();
      const reload = rig({ localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: vi.fn(async () => ({ kind: 'sent' as const })) });
      expect((await autopilotTick(reload.deps)).kind).toBe('busy');
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
    });

    it('(z3) a closed PR clears the guard', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      expect((await autopilotTick(rigRefused(failedRun('auto', 'head1')).deps)).kind).toBe('armed');
      store.db.prepare("UPDATE prs SET status = 'closed' WHERE ticket_id = ?").run(id);
      const closed = rig({ conflictRoundRefused: () => null });
      await autopilotTick(closed.deps);
      expect(getRefusedMerge(store, id)).toBeNull();
    });

    it('(z4) the delivered check takes the run head when the merge sha is unknown', async () => {
      // A long sha: the debug line shows its first 9 chars, so a wrong slice is visible.
      const RUN_HEAD = '9'.repeat(40);
      seedPr(PASSING);
      conflict();
      // The PR already holds the merge the gates ran on: no gate fix round for a merge that is on the PR.
      store.db.prepare('UPDATE prs SET head_oid = ? WHERE ticket_id = ?').run(RUN_HEAD, id);
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', RUN_HEAD);
      const r = rigRefused(runId, { conflictRoundRefused: () => refusal(runId, { sha: null }) });
      await autopilotTick(r.deps);
      expect(r.sendRefusedMergeFailure).not.toHaveBeenCalled();
      expect(getRefusedMerge(store, id)).toBeNull();
      expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: the refused merge 999999999 was delivered; the guard is cleared');
    });

    it('(z5) a stored guard with no run and no tail parks with the generic tail', async () => {
      seedPr(PASSING);
      conflict();
      store.db.prepare('INSERT OR IGNORE INTO autopilot_tickets (ticket_id) VALUES (?)').run(id);
      store.db.prepare('UPDATE autopilot_tickets SET refused_merge_repo = ?, refused_merge_sha = ? WHERE ticket_id = ?').run('r', SHA, id);
      const reload = rig({ localHead: async () => SHA, conflictRoundRefused: () => null });
      expect((await autopilotTick(reload.deps)).kind).toBe('parked');
      expect(stageBlock(store, id, 'ship')?.reason).toBe('auto-fix stopped: resolved merge not delivered: the gate fix round did not finish');
    });

    it('(z6) an older closed PR of the same repo does not answer for the branch still open', async () => {
      seedPr(PASSING);
      conflict();
      // The repo re-shipped: PR #2 closed, PR #5 open. Only the CURRENT row may clear the guard.
      store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)').run(id, 'r', 2, 'https://github.com/o/r/pull/2', 'closed');
      markConflictRound(store, id, Date.now());
      expect((await autopilotTick(rigRefused(failedRun('auto', 'head1')).deps)).kind).toBe('armed');
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
      const sent = vi.fn(async () => ({ kind: 'sent' as const }));
      const reload = rig({ localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: sent });
      expect((await autopilotTick(reload.deps)).kind).toBe('busy');
      expect(sent).not.toHaveBeenCalled();
      expect(getRefusedMerge(store, id)).toMatchObject({ repo: 'r', sha: SHA });
    });

    it('(z7) a fresh refusal does not inherit the run of an older stored refusal', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      // An older refusal with a readable run, stopped by the ask policy: its guard and run are stored.
      const ask = rigRefused(failedRun('auto', 'head1'), { config: () => ({ ...CFG, ci: { ...CFG.ci, policy: 'ask' } }) });
      expect((await autopilotTick(ask.deps)).kind).toBe('ask');
      expect(getRefusedMerge(store, id)?.runId).not.toBeNull();
      // A NEW refusal that names no deliver run must use no run at all: the old one belongs to another round.
      markConflictRound(store, id, Date.now());
      const newer = rigRefused(null);
      expect(await autopilotTick(newer.deps)).toEqual({ kind: 'parked', reason: REFUSED });
      expect(newer.sendRefusedMergeFailure).not.toHaveBeenCalled();
      expect(getRefusedMerge(store, id)).toBeNull();
    });

    it('(z8) a recovered round whose run has no head sha is retried, never wedged', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', null);
      const queued = rigRefused(runId, { concurrencyFull: () => true });
      expect(await autopilotTick(queued.deps)).toEqual({ kind: 'queued' });
      expect(getRefusedMerge(store, id)).toMatchObject({ sha: SHA, runId });
      const sent = vi.fn(async () => ({ kind: 'sent' as const }));
      const retried = rig({ localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: sent });
      expect(await autopilotTick(retried.deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
      expect(sent).toHaveBeenCalledOnce();
    });

    it('(z9) a sent round is found on the failed-gate repos, not the conflicted round repo', async () => {
      const RUN_HEAD = 'c'.repeat(40);
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = openDeliverRun(store, { ticketId: id, headSha: RUN_HEAD, gates: ['unit'], pid: 1, now: 'T0', kind: 'auto' });
      recordDeliverGate(store, runId, { gateName: 'unit', repo: 'a', exitCode: 1, summary: 'FAIL a', startedAt: null, endedAt: null });
      recordDeliverGate(store, runId, { gateName: 'unit', repo: 'b', exitCode: 1, summary: 'FAIL b', startedAt: null, endedAt: null });
      finishDeliverRun(store, runId, 'failed', 'T1');
      expect(await autopilotTick(rigRefused(runId).deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
      expect(getCiRoundHeadSha(store, id, 'a')).toBe(RUN_HEAD);
      // One failed repo still carries the round head, the other was re-shipped: the round ran, so the tick waits.
      setCiRoundHeadSha(store, id, 'b', 'e'.repeat(40));
      const sent = vi.fn(async () => ({ kind: 'sent' as const }));
      const reload = rig({ localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: sent });
      expect((await autopilotTick(reload.deps)).kind).toBe('busy');
      expect(sent).not.toHaveBeenCalled();
      expect(reload.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: the gate fix round ran for a at head ccccccccc; waiting for the fix');
      expect(stageBlock(store, id, 'ship')?.reason).toBe(NORMAL_BLOCK);
    });

    it('(z12) records each failed repo its own head, not the first planned repo head, for the round', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = openDeliverRun(store, { ticketId: id, headSha: 'firsthead', gates: ['unit'], pid: 1, now: 'T0', kind: 'auto' });
      recordDeliverGate(store, runId, { gateName: 'unit', repo: 'a', exitCode: 1, headSha: 'ahead', summary: 'FAIL a', startedAt: null, endedAt: null });
      recordDeliverGate(store, runId, { gateName: 'unit', repo: 'b', exitCode: 1, headSha: 'bhead', summary: 'FAIL b', startedAt: null, endedAt: null });
      finishDeliverRun(store, runId, 'failed', 'T1');
      expect(await autopilotTick(rigRefused(runId).deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
      expect(getCiRoundHeadSha(store, id, 'a')).toBe('ahead');
      expect(getCiRoundHeadSha(store, id, 'b')).toBe('bhead');
    });

    it('(z13) parks no-change on the same failed-repo heads, not the run head', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const multiRun = (head: string): number => {
        const runId = openDeliverRun(store, { ticketId: id, headSha: head, gates: ['unit'], pid: 1, now: 'T0', kind: 'auto' });
        recordDeliverGate(store, runId, { gateName: 'unit', repo: 'a', exitCode: 1, headSha: 'ahead', summary: 'FAIL a', startedAt: null, endedAt: null });
        recordDeliverGate(store, runId, { gateName: 'unit', repo: 'b', exitCode: 1, headSha: 'bhead', summary: 'FAIL b', startedAt: null, endedAt: null });
        finishDeliverRun(store, runId, 'failed', 'T1');
        return runId;
      };
      expect(await autopilotTick(rigRefused(multiRun('firsthead')).deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
      // The fix round came back: the failed repos did not commit, even though the run's first planned repo head changed.
      markConflictRound(store, id, Date.now());
      const second = rigRefused(multiRun('secondhead'));
      expect(await autopilotTick(second.deps)).toEqual({ kind: 'parked', reason: NO_CHANGE_BASE_MOVED_REASON });
      expect(second.sendRefusedMergeFailure).not.toHaveBeenCalled();
      expect(getAutopilotTicket(store, id).pausedReason).toBeNull();
    });

    it('(z10) a fresh refusal whose run cannot be read parks the fallback, using no other run', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      // The refusal names a run that is not this ticket's (deleted): nothing to repair, so the T1315 park stays.
      const r = rigRefused(99999);
      expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: REFUSED });
      expect(r.sendRefusedMergeFailure).not.toHaveBeenCalled();
      expect(getRefusedMerge(store, id)).toBeNull();
    });

    it('(z11) a stored guard whose run has no failed gate parks the fallback on recovery', async () => {
      seedPr(PASSING);
      conflict();
      markConflictRound(store, id, Date.now());
      const runId = failedRun('auto', 'head1');
      const queued = rigRefused(runId, { concurrencyFull: () => true });
      expect(await autopilotTick(queued.deps)).toEqual({ kind: 'queued' });
      // By the recovery the run's gates all pass (re-recorded): there is nothing for an agent to fix.
      store.db.prepare('UPDATE deliver_gate_results SET exit_code = 0 WHERE run_id = ?').run(runId);
      const sent = vi.fn(async () => ({ kind: 'sent' as const }));
      const reload = rig({ localHead: async () => SHA, conflictRoundRefused: () => null, sendRefusedMergeFailure: sent });
      expect(await autopilotTick(reload.deps)).toEqual({ kind: 'parked', reason: REFUSED });
      expect(sent).not.toHaveBeenCalled();
    });
  });

  // T1287: a manual round armed by the Resolve conflicts click has no store slot, so no engine stall could ever end it.
  it('ends a manual armed round once the PR is no longer conflicted, and the same tick starts the CI round', async () => {
    seedPr(failing('build'));
    conflict();
    const rounds = createConflictRounds();
    rounds.arm(id, { repo: 'r', baseSha: 'base1', files: ['a.ts'] });
    cleanMerge();
    const drop = vi.fn(() => rounds.disarm(id));
    const r = rig({
      conflictRoundActive: () => rounds.armed(id) !== null,
      conflictRoundEnded: () => conflictRoundEnded({ store, ticketId: id, rounds, prHead: () => 'h', cwd: () => '/w/r', git: async () => ({ code: 0, stdout: '' }) }),
      dropConflictRound: drop,
    });
    expect(await autopilotTick(r.deps)).toMatchObject({ kind: 'armed', problem: 'ci' });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(rounds.armed(id)).toBeNull();
    expect(r.sendCi).toHaveBeenCalledTimes(1);
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: the conflict round ended, the PR is no longer conflicted');
  });

  it('keeps the round and starts no round while the PR is still conflicted', async () => {
    seedPr(failing('build'));
    conflict();
    const rounds = createConflictRounds();
    rounds.arm(id, { repo: 'r', baseSha: 'base1', files: ['a.ts'] });
    const drop = vi.fn(() => rounds.disarm(id));
    const r = rig({
      conflictRoundActive: () => rounds.armed(id) !== null,
      conflictRoundEnded: () => conflictRoundEnded({ store, ticketId: id, rounds, prHead: () => 'h', cwd: () => '/w/r', git: async () => ({ code: 0, stdout: '' }) }),
      dropConflictRound: drop,
    });
    expect((await autopilotTick(r.deps)).kind).toBe('busy');
    expect(drop).not.toHaveBeenCalled();
    expect(rounds.armed(id)).not.toBeNull();
    expect(r.sendCi).not.toHaveBeenCalled();
  });

  it('reads the round-end seam only while a round is active', async () => {
    seedPr(PASSING);
    conflict();
    const ended = vi.fn(async () => true);
    const drop = vi.fn();
    const r = rig({ conflictRoundActive: () => false, conflictRoundEnded: ended, dropConflictRound: drop });
    await autopilotTick(r.deps);
    expect(ended).not.toHaveBeenCalled();
    expect(drop).not.toHaveBeenCalled();
  });

  it('says the wait again after a stalled round was dropped', async () => {
    seedPr(PASSING);
    conflict();
    const lines = (debug: ReturnType<typeof vi.fn>): number => debug.mock.calls.filter(([m]) => String(m).includes('no round, a conflict round is armed')).length;
    const busy = rig({ conflictRoundActive: () => true });
    await autopilotTick(busy.deps);
    expect(lines(busy.debug)).toBe(1);
    // The round stalls (an engine round with a receipt and no merge): it is dropped and its wait is forgotten.
    markConflictRound(store, id, Date.now());
    expect(await autopilotTick(rig({ conflictRoundActive: () => true, conflictRoundStalled: () => true }).deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: conflict round did not deliver' });
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: () => {}, debug: () => {} }, 'r', 'conflicts');
    const again = rig({ conflictRoundActive: () => true });
    await autopilotTick(again.deps);
    expect(lines(again.debug)).toBe(1);
  });

  it('logs "no round, a conflict round is armed" once per armed state, not every tick', async () => {
    seedPr(PASSING);
    conflict();
    const r = rig({ conflictRoundActive: () => true });
    const lines = (debug: ReturnType<typeof vi.fn>): number => debug.mock.calls.filter(([m]) => String(m).includes('no round, a conflict round is armed')).length;
    await autopilotTick(r.deps);
    await autopilotTick(r.deps);
    expect(lines(r.debug)).toBe(1);
    // The round ends: the next arming is a new state and says so once again.
    await autopilotTick(rig({ conflictRoundActive: () => false }).deps);
    const again = rig({ conflictRoundActive: () => true });
    await autopilotTick(again.deps);
    expect(lines(again.debug)).toBe(1);
  });

  it('marks the round on a sent conflict round and clears the mark when the round fails', async () => {
    seedPr(PASSING);
    conflict();
    await autopilotTick(rig().deps);
    expect((store.db.prepare('SELECT conflict_round_at AS at FROM autopilot_tickets WHERE ticket_id = ?').get(id) as { at: number | null }).at).not.toBeNull();
    clearConflictRound(store, id);
    setAutopilotOverride(store, id, 'on');
    await autopilotTick(rig({}, { kind: 'failed', reason: 'x' }).deps);
    expect((store.db.prepare('SELECT conflict_round_at AS at FROM autopilot_tickets WHERE ticket_id = ?').get(id) as { at: number | null }).at).toBeNull();
  });

  it('parks a spent budget before it waits for a slot, and keeps the attempt of a waiting round', async () => {
    seedPr(PASSING);
    conflict();
    const waiting = rig({ concurrencyFull: () => true });
    expect((await autopilotTick(waiting.deps)).kind).toBe('queued');
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
    takeAutopilotAttempt(store, id, 'r', 'conflicts', 'base1', 2);
    takeAutopilotAttempt(store, id, 'r', 'conflicts', 'base1', 2);
    const spent = rig({ concurrencyFull: () => true });
    expect(await autopilotTick(spent.deps)).toMatchObject({ kind: 'parked', reason: 'auto-fix stopped: conflicts 2/2' });
  });

  it('a conflict that starts no round (ask policy) does not block a CI round', async () => {
    seedPr(failing('build'));
    conflict();
    const r = rig({ config: () => ({ ...CFG, conflicts: { policy: 'ask', maxRounds: 2 } }) });
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(r.sendCi).toHaveBeenCalledTimes(1);
    expect(r.sendConflict).not.toHaveBeenCalled();
  });
});

describe('autopilotTick transient CI re-run (T1019)', () => {
  const URL_V = 'https://github.com/o/r/actions/runs/100/job/200';
  const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
  const NET_LOG = '2026-11-08T10:00:00.1Z prebuild-install warn install Request timed out\n';
  const REAL_LOG = '2026-11-08T10:00:00.1Z FAIL src/a.test.ts\n2026-11-08T10:00:00.2Z AssertionError: Request timed out\n';
  const withUrl = (...names: string[]) => ({ ...failing(...names), failing: names.map((name) => ({ name, url: URL_V })) });

  function ciRig(log: string | Error, over: Partial<AutopilotDeps> = {}): Rig & { rerun: ReturnType<typeof vi.fn>; readLog: ReturnType<typeof vi.fn> } {
    const rerun = vi.fn(async (_cwd: string, _c: unknown) => {});
    const readLog = vi.fn(async (_cwd: string, _c: unknown) => { if (log instanceof Error) throw log; return log; });
    const r = rig({
      transientCi: { readJobLog: readLog, readRunHeadSha: async () => SHA, rerunFailedJobs: rerun },
      ...over,
    });
    return { ...r, rerun, readLog };
  }

  it('re-runs a transient failure of a non-allowlisted check once and does not park', async () => {
    seedPr(withUrl('Visual'));
    const r = ciRig(NET_LOG);
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'rerun' });
    expect(r.rerun).toHaveBeenCalledTimes(1);
    expect(r.rerun.mock.calls[0]![1]).toMatchObject({ runId: '100', jobId: '200' });
    expect(r.notes[0]![0]).toBe('Autopilot: re-ran Visual on abcdef012 after a network error (request-timed-out)');
    expect(r.debug).toHaveBeenCalledWith(expect.stringContaining('[ship] autopilot ticket AP-1 ci: re-ran Visual on abcdef012'));
    expect(stageBlock(store, id, 'ship')?.reason).toBe(NORMAL_BLOCK);
    expect(r.sendCi).not.toHaveBeenCalled();
    // The stored rollup (the failed attempt) is forgotten, so the ticket waits for the next probe.
    expect((await autopilotTick(ciRig(NET_LOG).deps)).kind).toBe('nothing');
  });

  it('parks on a second failure and names the earlier re-run', async () => {
    seedPr(withUrl('Visual'));
    await autopilotTick(ciRig(NET_LOG).deps);
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify(withUrl('Visual')), id);
    const later = ciRig(NET_LOG, { now: () => Date.now() + 10 * 60_000 });
    const result = await autopilotTick(later.deps);
    expect(later.rerun).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'parked', reason: 'auto-fix not run: ci check Visual is not on the allowlist (re-run once after a network error and it failed again)' });
  });

  it('waits while a fresh re-run is still settling', async () => {
    seedPr(withUrl('Visual'));
    await autopilotTick(ciRig(NET_LOG).deps);
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify(withUrl('Visual')), id);
    expect((await autopilotTick(ciRig(NET_LOG).deps)).kind).toBe('rerun');
    expect(stageBlock(store, id, 'ship')?.reason).toBe(NORMAL_BLOCK);
  });

  it('re-runs an allowlisted check before any CI round and spends no attempt', async () => {
    seedPr(withUrl('build'));
    const r = ciRig(NET_LOG);
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'rerun' });
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    // After a second failure today's rule applies: a CI round that spends an attempt.
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify(withUrl('build')), id);
    const later = ciRig(NET_LOG, { now: () => Date.now() + 10 * 60_000 });
    expect((await autopilotTick(later.deps)).kind).toBe('armed');
    expect(later.rerun).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
  });

  it('does not re-run the same (run, check) again after a reload', async () => {
    seedPr(withUrl('Visual'));
    await autopilotTick(ciRig(NET_LOG).deps);
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify(withUrl('Visual')), id);
    // A reload is a new engine over the same store: a fresh rig, a later clock.
    const reloaded = ciRig(NET_LOG, { now: () => Date.now() + 10 * 60_000 });
    await autopilotTick(reloaded.deps);
    expect(reloaded.rerun).not.toHaveBeenCalled();
    expect(reloaded.readLog).not.toHaveBeenCalled();
  });

  it('does not re-run a real failure and keeps today\'s park', async () => {
    seedPr(withUrl('Visual'));
    const r = ciRig(REAL_LOG);
    const result = await autopilotTick(r.deps);
    expect(r.rerun).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'parked', reason: 'auto-fix not run: ci check Visual is not on the allowlist' });
  });

  it('parks with the existing reason when gh fails to read the log', async () => {
    seedPr(withUrl('build'));
    const r = ciRig(new Error('reading the job log failed (gh exit 1: HTTP 403)'));
    const result = await autopilotTick(r.deps);
    expect(result).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci could not run (reading the job log failed (gh exit 1: HTTP 403))' });
    expect(r.rerun).not.toHaveBeenCalled();
    expect(r.sendCi).not.toHaveBeenCalled();
  });

  it('parks with the existing reason when gh fails to start the re-run', async () => {
    seedPr(withUrl('Visual'));
    const r = ciRig(NET_LOG);
    r.rerun.mockRejectedValueOnce(new Error('the re-run failed (gh exit 1)'));
    expect((await autopilotTick(r.deps)).kind).toBe('parked');
    expect(stageBlock(store, id, 'ship')?.reason).toBe('auto-fix stopped: ci could not run (the re-run failed (gh exit 1))');
  });

  it('leaves a status context without a job url to today\'s rules', async () => {
    seedPr({ ...failing('Visual'), failing: [{ name: 'Visual', url: null }] });
    const r = ciRig(NET_LOG);
    expect((await autopilotTick(r.deps)).kind).toBe('parked');
    expect(r.readLog).not.toHaveBeenCalled();
  });

  it('re-runs a transient failure of a sandboxed ticket once, like a host ticket', async () => {
    seedPr(withUrl('Visual'));
    const r = ciRig(NET_LOG, { placement: async () => 'sandbox' });
    expect((await autopilotTick(r.deps)).kind).toBe('rerun');
    expect(r.readLog).toHaveBeenCalled();
  });

  it('keeps today\'s park for a graph ticket and for a placement that cannot be read', async () => {
    seedPr(withUrl('Visual'));
    const graph = ciRig(NET_LOG, { isGraphTicket: () => true });
    expect((await autopilotTick(graph.deps)).kind).toBe('parked');
    expect(graph.readLog).not.toHaveBeenCalled();
    store.db.prepare("UPDATE autopilot_tickets SET stopped_reason = NULL WHERE ticket_id = ?").run(id);
    const unknown = ciRig(NET_LOG, { placement: async () => { throw new Error('no placement'); } });
    await autopilotTick(unknown.deps);
    expect(unknown.readLog).not.toHaveBeenCalled();
  });

  it('does nothing extra when no gh seams are given', async () => {
    seedPr(withUrl('Visual'));
    expect(await autopilotTick(rig().deps)).toMatchObject({ kind: 'parked', reason: 'auto-fix not run: ci check Visual is not on the allowlist' });
  });

  it('writes the gh error into the note body of the park', async () => {
    seedPr(withUrl('build'));
    const r = ciRig(new Error('boom'));
    await autopilotTick(r.deps);
    expect(r.notes[0]).toEqual(['Autopilot: auto-fix stopped: ci could not run (boom)', 'AP-1 (ci): the action failed (boom); the ticket stays in ship and no attempt was used.']);
    expect(getAutopilotTicket(store, id).pausedReason).toBe('auto-fix stopped: ci could not run (boom)');
  });
});

describe('autopilotTick stale generated file (T1081)', () => {
  const URL_V = 'https://github.com/o/r/actions/runs/100/job/200';
  const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
  const CMD = 'npm run -s docs:graph';
  const STALE_LOG = `2026-11-08T10:00:00.1Z docs/arch/system-map.md is stale: run ${CMD}\n2026-11-08T10:00:00.2Z ##[error]Process completed with exit code 1.\n`;
  const TEST_LOG = `${STALE_LOG}2026-11-08T10:00:00.3Z FAIL src/a.test.ts\n`;
  const withUrl = (...names: string[]) => ({ ...failing(...names), failing: names.map((name) => ({ name, url: URL_V })) });

  function staleRig(log: string, rebased = true, over: Partial<AutopilotDeps> = {}): Rig & { rebase: ReturnType<typeof vi.fn>; rerun: ReturnType<typeof vi.fn> } {
    const rebase = vi.fn(async (_repo: string) => rebased);
    const rerun = vi.fn(async () => {});
    const r = rig({
      staleRebase: { readJobLog: async () => log, readRunHeadSha: async () => SHA, regenerate: () => [CMD], rebase },
      transientCi: { readJobLog: async () => log, readRunHeadSha: async () => SHA, rerunFailedJobs: rerun },
      ...over,
    });
    return { ...r, rebase, rerun };
  }

  it('rebases once for a stale generated failure, writes the marker first, uses no attempt and writes one note', async () => {
    seedPr(withUrl('Docs gate'));
    const r = staleRig(STALE_LOG);
    r.rebase.mockImplementationOnce(async () => {
      expect(getAutopilotRerun(store, id, 'r', '100', 'Docs gate')?.pattern).toBe(`stale-generated:${CMD}`);
      return true;
    });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'rebased' });
    expect(r.rebase).toHaveBeenCalledTimes(1);
    expect(r.rebase).toHaveBeenCalledWith('r');
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]![0]).toBe(`Autopilot: rebased on base for ${CMD} after Docs gate failed on abcdef012`);
    expect(stageBlock(store, id, 'ship')?.reason).toBe(NORMAL_BLOCK);
  });

  // The CI run that follows the rebase has another run id.
  const newRun = (...names: string[]) => ({ ...failing(...names), failing: names.map((name) => ({ name, url: URL_V.replace(/runs\/\d+/, 'runs/999999') })) });

  it('waits, with no second rebase and no park, when the same run is read again right after the push', async () => {
    seedPr(withUrl('Docs gate'));
    await autopilotTick(staleRig(STALE_LOG).deps);
    const later = staleRig(STALE_LOG);
    expect(await autopilotTick(later.deps)).toEqual({ kind: 'rebased' });
    expect(later.rebase).not.toHaveBeenCalled();
    expect(stageBlock(store, id, 'ship')?.reason).toBe(NORMAL_BLOCK);
  });

  it('takes today\'s path on a second failure on a later run (no second rebase)', async () => {
    seedPr(withUrl('Docs gate'));
    await autopilotTick(staleRig(STALE_LOG).deps);
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify(newRun('Docs gate')), id);
    const later = staleRig(STALE_LOG);
    const result = await autopilotTick(later.deps);
    expect(later.rebase).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'parked', reason: 'auto-fix not run: ci check Docs gate is not on the allowlist (rebased once for a stale generated file and it failed again)' });
  });

  it('gives an allowlisted check a CI round after the rebase failed again', async () => {
    seedPr(withUrl('build'));
    await autopilotTick(staleRig(STALE_LOG).deps);
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify(newRun('build')), id);
    const later = staleRig(STALE_LOG);
    expect((await autopilotTick(later.deps)).kind).toBe('armed');
    expect(later.rebase).not.toHaveBeenCalled();
  });

  it('takes today\'s path when the rebase stops, and does not rebase again', async () => {
    seedPr(withUrl('Docs gate'));
    const r = staleRig(STALE_LOG, false);
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix not run: ci check Docs gate is not on the allowlist (rebased once for a stale generated file and it failed again)' });
    expect(r.rebase).toHaveBeenCalledTimes(1);
  });

  it('takes today\'s path for a sandboxed ticket and a graph ticket', async () => {
    seedPr(withUrl('Docs gate'));
    const sandbox = staleRig(STALE_LOG, true, { placement: async () => 'sandbox' });
    expect((await autopilotTick(sandbox.deps)).kind).toBe('parked');
    expect(sandbox.rebase).not.toHaveBeenCalled();
    store.db.prepare('UPDATE autopilot_tickets SET stopped_reason = NULL WHERE ticket_id = ?').run(id);
    const graph = staleRig(STALE_LOG, true, { isGraphTicket: () => true });
    await autopilotTick(graph.deps);
    expect(graph.rebase).not.toHaveBeenCalled();
  });

  it('takes today\'s path for a failure with another error line and for a check without a job url', async () => {
    seedPr(withUrl('Docs gate'));
    const other = staleRig(TEST_LOG);
    expect((await autopilotTick(other.deps)).kind).toBe('parked');
    expect(other.rebase).not.toHaveBeenCalled();
    store.db.prepare('UPDATE autopilot_tickets SET stopped_reason = NULL WHERE ticket_id = ?').run(id);
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify({ ...failing('Docs gate'), failing: [{ name: 'Docs gate', url: null }] }), id);
    const noUrl = staleRig(STALE_LOG);
    await autopilotTick(noUrl.deps);
    expect(noUrl.rebase).not.toHaveBeenCalled();
  });

  it('takes today\'s path when no stale seam is bound', async () => {
    seedPr(withUrl('build'));
    const placement = vi.fn(async () => 'host' as const);
    const r = rig({ staleRebase: undefined, transientCi: undefined, placement });
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    // Only the CI round reads the placement; the stale step must not.
    expect(placement).toHaveBeenCalledTimes(1);
  });

  it('takes today\'s path when the placement cannot be read', async () => {
    seedPr(withUrl('Docs gate'));
    const r = staleRig(STALE_LOG, true, { placement: async () => { throw new Error('no backend'); } });
    expect((await autopilotTick(r.deps)).kind).toBe('parked');
    expect(r.rebase).not.toHaveBeenCalled();
  });

  it('does not rebase when only some failing checks are stale-generated', async () => {
    seedPr({ ...failing('Docs gate', 'Visual'), failing: [{ name: 'Docs gate', url: URL_V }, { name: 'Visual', url: 'https://github.com/o/r/actions/runs/100/job/201' }] });
    const r = staleRig(STALE_LOG, true, {
      staleRebase: { readJobLog: async (_cwd, c) => (c.jobId === '200' ? STALE_LOG : TEST_LOG), readRunHeadSha: async () => SHA, regenerate: () => [CMD], rebase: vi.fn(async () => true) },
    });
    await autopilotTick(r.deps);
    expect(r.deps.staleRebase!.rebase).not.toHaveBeenCalled();
    expect(r.rebase).not.toHaveBeenCalled();
  });
});

describe('autopilotTick CI round that made no commit (D564)', () => {
  const URL_V = 'https://github.com/o/r/actions/runs/100/job/200';
  const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
  const REAL_LOG = '2026-11-08T10:00:00.1Z FAIL src/a.test.ts\n2026-11-08T10:00:00.2Z AssertionError: expected 1 to be 2\n';
  const withUrl = (...names: string[]) => ({ ...failing(...names), failing: names.map((name) => ({ name, url: URL_V })) });
  const reseed = (): void => { store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify(withUrl('build')), id); };

  function nrig(over: Partial<AutopilotDeps> = {}, o: { sha?: string; rerun?: Error } = {}): Rig & { rerun: ReturnType<typeof vi.fn> } {
    const rerun = vi.fn(async (_cwd: string, _c: unknown) => { if (o.rerun) throw o.rerun; });
    const r = rig({ transientCi: { readJobLog: async () => REAL_LOG, readRunHeadSha: async () => o.sha ?? SHA, rerunFailedJobs: rerun }, ...over });
    return { ...r, rerun };
  }
  /** Round 1 goes out; the agent commits nothing, so the same failed run is read again. */
  async function emptyRound(): Promise<void> {
    seedPr(withUrl('build'));
    expect((await autopilotTick(nrig().deps)).kind).toBe('armed');
    reseed();
  }

  it('re-runs the failed jobs once and uses no attempt when the round made no commit', async () => {
    await emptyRound();
    const r = nrig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'rerun' });
    expect(r.rerun).toHaveBeenCalledTimes(1);
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
    expect(getAutopilotRerun(store, id, 'r', '100', 'build')?.pattern).toBe('no-change');
    expect(r.notes[0]![0]).toBe('Autopilot: build abcdef012 re-run once: the ci round made no commit');
    // The stored rollup of the failed attempt is forgotten: the ticket waits for the next probe.
    expect((await autopilotTick(nrig().deps)).kind).toBe('nothing');
  });

  it('parks when the check fails again on the same head after the one re-run', async () => {
    await emptyRound();
    await autopilotTick(nrig().deps);
    reseed();
    const later = nrig({ now: () => Date.now() + 10 * 60_000 });
    const result = await autopilotTick(later.deps);
    expect(result).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci round made no change' });
    expect(later.rerun).not.toHaveBeenCalled();
    expect(later.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
    expect(later.notes[0]![1]).toBe('AP-1 (ci): the agent made no commit and the check failed again after one re-run; fix it by hand or approve one more attempt.');
    expect(stageBlock(store, id, 'ship')?.reason).toBe('auto-fix stopped: ci round made no change');
    // The stop names the head it applies to: the failing run head recorded when the round was sent (arch:AP-00).
    expect(getAutopilotTicket(store, id).stoppedHeadSha).toBe(getCiRoundHeadSha(store, id, 'r'));
    expect(getAutopilotTicket(store, id).stoppedHeadSha).not.toBeNull();
  });

  it('records the failing run head only when a round was sent (armed), and only with the transient seams', async () => {
    seedPr(withUrl('build'));
    expect((await autopilotTick(nrig({}).deps)).kind).toBe('armed');
    expect(getCiRoundHeadSha(store, id, 'r')).toBe(SHA);
  });

  it('records no head when the round did not go out', async () => {
    seedPr(withUrl('build'));
    const r = nrig();
    r.sendCi.mockResolvedValueOnce({ kind: 'failed', reason: 'boom' });
    expect((await autopilotTick(r.deps)).kind).toBe('parked');
    expect(getCiRoundHeadSha(store, id, 'r')).toBeNull();
  });

  it('records no head and does not fail without the transient seams', async () => {
    seedPr(withUrl('build'));
    expect((await autopilotTick(rig().deps)).kind).toBe('armed');
    expect(getCiRoundHeadSha(store, id, 'r')).toBeNull();
  });

  it('does not re-run for a graph ticket, even with a recorded head', async () => {
    await emptyRound();
    const r = nrig({ isGraphTicket: () => true });
    await autopilotTick(r.deps);
    expect(r.rerun).not.toHaveBeenCalled();
  });

  it('does not re-run when the placement cannot be read', async () => {
    await emptyRound();
    const r = nrig({ placement: async () => { throw new Error('probe failed'); } });
    await autopilotTick(r.deps);
    expect(r.rerun).not.toHaveBeenCalled();
  });

  it('pauses the ticket with the reason when the re-run fails', async () => {
    await emptyRound();
    const r = nrig({}, { rerun: new Error('gh exit 1') });
    await autopilotTick(r.deps);
    expect(getAutopilotTicket(store, id).pausedReason).toBe('auto-fix stopped: ci could not run (gh exit 1)');
    expect(r.notes[0]![1]).toBe('AP-1 (ci): the action failed (gh exit 1); the ticket stays in ship and no attempt was used.');
  });

  it('does not pause the ticket for the no-change stop', async () => {
    await emptyRound();
    await autopilotTick(nrig().deps);
    reseed();
    await autopilotTick(nrig({ now: () => Date.now() + 10 * 60_000 }).deps);
    expect(getAutopilotTicket(store, id).pausedReason).toBeNull();
  });

  it('approve one more for a conflict attempt keeps the recorded ci head', async () => {
    seedPr(withUrl('build'));
    takeAutopilotAttempt(store, id, 'r', 'ci', 'build', 3);
    setCiRoundHeadSha(store, id, 'r', SHA);
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: () => {}, debug: () => {} }, 'r', 'conflicts');
    expect(getCiRoundHeadSha(store, id, 'r')).toBe(SHA);
  });

  it('starts a normal round when the run head is a new commit', async () => {
    await emptyRound();
    const r = nrig({}, { sha: '2222222222222222222222222222222222222222' });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'armed', problem: 'ci', used: 2, max: 3 });
    expect(r.rerun).not.toHaveBeenCalled();
  });

  it('does not re-run again after a reload while the marker holds', async () => {
    await emptyRound();
    await autopilotTick(nrig().deps);
    reseed();
    const reloaded = nrig();
    expect(await autopilotTick(reloaded.deps)).toEqual({ kind: 'rerun' });
    expect(reloaded.rerun).not.toHaveBeenCalled();
  });

  it('parks with the could-not-run reason when gh fails in the re-run', async () => {
    await emptyRound();
    const r = nrig({}, { rerun: new Error('gh exit 1') });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci could not run (gh exit 1)' });
    expect(r.sendCi).not.toHaveBeenCalled();
  });

  it('after a gh failure in the re-run a later tick re-runs again, and does not park as if it failed twice', async () => {
    await emptyRound();
    expect((await autopilotTick(nrig({}, { rerun: new Error('gh exit 1') }).deps)).kind).toBe('parked');
    expect(getAutopilotRerun(store, id, 'r', '100', 'build')).toBeNull();
    setAutopilotPaused(store, id, null); // Retry
    clearParkBlock(store, id);
    reseed();
    const r = nrig({ now: () => Date.now() + 10 * 60_000 });
    expect((await autopilotTick(r.deps)).kind).toBe('rerun');
    expect(r.rerun).toHaveBeenCalledTimes(1);
  });

  it('approve one more clears the no-change state of every repo of the ticket', async () => {
    await emptyRound();
    takeAutopilotAttempt(store, id, 'other', 'ci', 'x', 3);
    setCiRoundHeadSha(store, id, 'other', SHA);
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: () => {}, debug: () => {} }, 'r', 'ci');
    expect(getCiRoundHeadSha(store, id, 'other')).toBeNull();
  });

  it('starts a round again after a person approves one more attempt', async () => {
    await emptyRound();
    await autopilotTick(nrig().deps);
    reseed();
    await autopilotTick(nrig({ now: () => Date.now() + 10 * 60_000 }).deps);
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: () => {}, debug: () => {} }, 'r', 'ci');
    reseed();
    const r = nrig({ now: () => Date.now() + 10 * 60_000 });
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(r.sendCi).toHaveBeenCalledTimes(1);
  });
});

describe('autopilotTick CI round with no commit after a network re-run (D564)', () => {
  const URL_V = 'https://github.com/o/r/actions/runs/100/job/200';
  const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
  const NET_LOG = '2026-11-08T10:00:00.1Z prebuild-install warn install Request timed out\n';
  const REAL_LOG = '2026-11-08T10:00:00.1Z FAIL src/a.test.ts\n2026-11-08T10:00:00.2Z AssertionError: expected 1 to be 2\n';
  const withUrl = (...names: string[]) => ({ ...failing(...names), failing: names.map((name) => ({ name, url: URL_V })) });
  const reseed = (): void => { store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify(withUrl('build')), id); };
  const later = (log: string, over: Partial<AutopilotDeps> = {}) => {
    const rerun = vi.fn(async (_cwd: string, _c: unknown) => {});
    const r = rig({ transientCi: { readJobLog: async () => log, readRunHeadSha: async () => SHA, rerunFailedJobs: rerun }, ...over });
    return { ...r, rerun };
  };

  it('parks instead of sending round 2 when the same run was re-run for a network error and the round made no commit', async () => {
    seedPr(withUrl('build'));
    expect((await autopilotTick(later(NET_LOG).deps)).kind).toBe('rerun');
    reseed();
    const settled = (): number => Date.now() + 10 * 60_000;
    expect((await autopilotTick(later(REAL_LOG, { now: settled }).deps)).kind).toBe('armed');
    reseed();
    const r = later(REAL_LOG, { now: settled });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci round made no change' });
    expect(r.rerun).not.toHaveBeenCalled();
    expect(r.sendCi).not.toHaveBeenCalled();
  });
});

describe('a park that lands after a send-back (T1122)', () => {
  /** A tick that starts at ship; the send-back lands while the placement read awaits, then the read fails and the tick parks. */
  const sentBackWhileAwaiting = (): Rig => rig({
    placement: async () => { sendBackToImplement(store, id); throw new Error('placement lost'); },
  });

  it('writes no block and no stop reason on a ticket that left ship', async () => {
    seedPr(failing('build'));
    const r = sentBackWhileAwaiting();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'idle' });
    expect(getTicket(store, id).stageCurrent).toBe('impl');
    expect(stageBlock(store, id, 'ship')).toBeNull();
    expect(getAutopilotTicket(store, id).stoppedReason).toBeNull();
    expect(r.notes).toEqual([]);
    expect(r.debug).toHaveBeenCalledWith(expect.stringContaining('left ship'));
  });

  it('writes no block while the ship stage is not shipped (status pending)', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => { setStage(store, id, 'ship', { status: 'pending', blockedKind: null, blockedReason: null, blockedAt: null }); throw new Error('x'); } });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'idle' });
    expect(stageBlock(store, id, 'ship')).toBeNull();
    expect(getAutopilotTicket(store, id).stoppedReason).toBeNull();
  });

  it('returns idle on ship:pending with no block (unchanged)', async () => {
    seedPr(failing('build'));
    setStage(store, id, 'ship', { status: 'pending', blockedKind: null, blockedReason: null, blockedAt: null });
    expect(await autopilotTick(rig().deps)).toEqual({ kind: 'idle' });
  });
});

describe('a conflict round that a window reload interrupts (T1162, @arch:AP-01)', () => {
  const STALLED = 'auto-fix stopped: conflict round did not deliver';

  it('resumes the auto-deliver from the stored slot with no new round and no attempt', async () => {
    seedPr(PASSING);
    conflict();
    markConflictRound(store, id, Date.now());
    const resume = vi.fn(async () => 'started' as const);
    const r = rig({ resumeDeliver: resume });
    expect((await autopilotTick(r.deps)).kind).toBe('busy');
    expect(resume).toHaveBeenCalledWith(true);
    expect(r.sendConflict).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
    expect(r.notes[0]![0]).toBe('Autopilot: resumed the auto-deliver after a reload');
    expect(r.debug).toHaveBeenCalledWith(expect.stringContaining('[ship] autopilot ticket AP-1: resumed the auto-deliver after a reload'));
    expect(getConflictRoundAt(store, id)).not.toBeNull();
  });

  it('delivers a finished local merge without a stored slot and sends no round', async () => {
    seedPr(PASSING);
    conflict();
    const resume = vi.fn(async () => 'started' as const);
    const r = rig({ resumeDeliver: resume });
    expect((await autopilotTick(r.deps)).kind).toBe('busy');
    expect(resume).toHaveBeenCalledWith(false);
    expect(r.sendConflict).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
  });

  it('does not park or drop the round while the PR head is unknown, and the other steps still run', async () => {
    seedPr(failing('build'));
    markConflictRound(store, id, Date.now());
    const drop = vi.fn();
    const r = rig({ resumeDeliver: async () => 'wait', dropConflictRound: drop });
    await autopilotTick(r.deps);
    expect(drop).not.toHaveBeenCalled();
    expect(getAutopilotTicket(store, id).stoppedReason).toBeNull();
    expect(getConflictRoundAt(store, id)).not.toBeNull();
  });

  it('parks and drops a reloaded round whose merge is not finished, and the park holds', async () => {
    seedPr(PASSING);
    conflict();
    markConflictRound(store, id, Date.now());
    const drop = vi.fn();
    const r = rig({ resumeDeliver: async () => 'unfinished', dropConflictRound: drop });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: STALLED });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(r.sendConflict).not.toHaveBeenCalled();
    expect(getConflictRoundAt(store, id)).toBeNull();
    // T1160: the local probe reads clean and CI is green on the old PR head. The PR head is not the local head.
    store.db.prepare("UPDATE prs SET head_oid = 'oldpr', checks = ?").run(JSON.stringify(PASSING));
    cleanMerge();
    expect((await autopilotTick(rig().deps)).kind).toBe('idle');
    expect(getAutopilotTicket(store, id).stoppedReason).toBe(STALLED);
  });

  it('starts no round from a conflict row of an older head than the local head', async () => {
    seedPr(PASSING);
    conflict();
    const r = rig({ localHead: async () => 'newer' });
    expect((await autopilotTick(r.deps)).kind).toBe('nothing');
    expect(r.sendConflict).not.toHaveBeenCalled();
  });

  it('runs no CI round on a PR whose conflict row is stale', async () => {
    seedPr(failing('build'));
    conflict();
    const r = rig({ localHead: async () => 'newer' });
    await autopilotTick(r.deps);
    expect(r.sendCi).not.toHaveBeenCalled();
  });

  it('starts a round from a conflict row of the local head', async () => {
    seedPr(PASSING);
    conflict();
    const r = rig({ localHead: async () => 'h' });
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(r.sendConflict).toHaveBeenCalledTimes(1);
  });

  describe('provenClean reads GitHub, not only the local merge check', () => {
    beforeEach(() => { setAutopilotStopped(store, id, STALLED); });

    it('is false while the local head is not the PR head', async () => {
      seedPr(PASSING);
      store.db.prepare("UPDATE prs SET head_oid = 'oldpr'").run();
      cleanMerge();
      expect((await autopilotTick(rig().deps)).kind).toBe('idle');
    });

    it('is false while GitHub reports the merge as dirty', async () => {
      seedPr(PASSING);
      store.db.prepare("UPDATE prs SET head_oid = 'h', merge_block = 'dirty'").run();
      cleanMerge();
      expect((await autopilotTick(rig().deps)).kind).toBe('idle');
    });

    it('is true when GitHub holds the local head and reports no block', async () => {
      seedPr(PASSING);
      store.db.prepare("UPDATE prs SET head_oid = 'h', merge_block = 'clean'").run();
      cleanMerge();
      expect((await autopilotTick(rig().deps)).kind).not.toBe('idle');
    });
  });
});

describe('a hand-merge resume whose deliver fails (T1162, @arch:AP-01)', () => {
  it('drops the stalled round and parks, so the engine is never blocked forever', async () => {
    seedPr(PASSING);
    // The resume stored a slot when it armed the hand merge; the deliver failed and the round stalled.
    markConflictRound(store, id, Date.now() - 1);
    const drop = vi.fn();
    const r = rig({ resumeDeliver: async () => 'none', conflictRoundActive: () => true, conflictRoundStalled: () => true, dropConflictRound: drop });
    await autopilotTick(r.deps);
    expect(drop).toHaveBeenCalled();
    expect(getConflictRoundAt(store, id)).toBeNull();
    expect(getAutopilotTicket(store, id).stoppedReason).toContain('did not deliver');
  });
});

describe('the ship retry after a GitHub server error (T1362, @arch:AP-11)', () => {
  const ENDED = '2026-11-25T12:00:00.000Z';
  const AT = Date.parse('2026-11-25T12:10:00.000Z');
  const HEAD = 'a'.repeat(40);

  /** One failed run of `r` whose `pr` step carries a GitHub server error. */
  function failedServerErrorShip(runs = 1, endedAt = ENDED, forId = id): number {
    let last = 0;
    setStage(store, forId, 'ship', { status: 'failed', startedAt: '2026-11-25T11:00:00.000Z', endedAt, blockedKind: null, blockedReason: null, blockedAt: null });
    for (let i = 0; i < runs; i += 1) {
      const r = openShipRun(store, { ticketId: forId, attempt: i + 1, startedAt: '2026-11-25T11:59:00.000Z' });
      const s = openShipRepoStep(store, { shipRunId: r.id, repo: 'r', step: 'pr', detail: 'run', startedAt: '2026-11-25T11:59:00.000Z' });
      finishShipRepoStep(store, s.id, { status: 'failed', detail: 'gh: HTTP 502 Bad Gateway', endedAt });
      beginShipOperationPreparation(store, {
        shipRunId: r.id, repo: 'r', step: 'push', operationKey: `push-${forId}-${r.id}`, createdAt: '2026-11-25T11:59:00.000Z',
        preState: { step: 'push', localHead: HEAD, remote: 'origin', ref: 'b', preRemoteHead: null },
      });
      closeShipRun(store, r.id, 'failed', endedAt);
      if (i === runs - 1) last = r.id;
    }
    return last;
  }
  /** A passed run with no steps: it resets the consecutive-failure count without changing the repo evidence. */
  function passedRun(at: string, forId = id): void {
    const r = openShipRun(store, { ticketId: forId, attempt: 99, startedAt: '2026-11-25T12:59:00.000Z' });
    closeShipRun(store, r.id, 'passed', at);
  }
  const retrySeams = { shipRetry: { worktreeClean: async () => ({ ok: true as const, clean: true }), localHead: async () => HEAD } };
  const retry = (over: Partial<AutopilotDeps> = {}) => {
    const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
    return { ...rig({ now: () => AT, retryShip, ...retrySeams, ...over }), retryShip: over.retryShip ?? retryShip };
  };

  it('retries the confirmed ship after the backoff and records one event', async () => {
    failedServerErrorShip();
    const r = retry();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'shipRetried' });
    expect(r.retryShip).toHaveBeenCalledWith(['r']);
    expect(r.notes).toEqual([[
      'Autopilot: retried ship after a GitHub server error (1/5)',
      'AP-1: ran Retry ship for r after a GitHub server error (retry 1/5).',
    ]]);
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: retried ship after a GitHub server error (1/5) for r');
  });

  it('retries every repo Retry ship names, joined with a comma', async () => {
    const runId = failedServerErrorShip();
    const step = openShipRepoStep(store, { shipRunId: runId, repo: 'z', step: 'pr', detail: 'run', startedAt: '2026-11-25T11:59:00.000Z' });
    finishShipRepoStep(store, step.id, { status: 'failed', detail: 'HTTP 503 Service Unavailable', endedAt: ENDED });
    beginShipOperationPreparation(store, {
      shipRunId: runId, repo: 'z', step: 'push', operationKey: `push-z-${runId}`, createdAt: '2026-11-25T11:59:00.000Z',
      preState: { step: 'push', localHead: HEAD, remote: 'origin', ref: 'b', preRemoteHead: null },
    });
    const r = retry();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'shipRetried' });
    expect(r.retryShip).toHaveBeenCalledTimes(1);
    expect(r.notes[0]![1]).toMatch(/for (r, z|z, r) after a GitHub server error \(retry 1\/5\)\.$/);
    expect(r.debug).toHaveBeenCalledWith(expect.stringMatching(/\(1\/5\) for (r, z|z, r)$/));
  });

  it('reads no worktree and writes no stop for a sandboxed ticket, even at the bound', async () => {
    failedServerErrorShip(6);
    const worktreeClean = vi.fn(async () => ({ ok: true as const, clean: true }));
    const localHead = vi.fn(async () => HEAD);
    const r = retry({ placement: async () => 'sandbox' as const, shipRetry: { worktreeClean, localHead } });
    expect((await autopilotTick(r.deps)).kind).toBe('idle');
    expect(worktreeClean).not.toHaveBeenCalled();
    expect(localHead).not.toHaveBeenCalled();
    expect(r.notes).toEqual([]);
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: no ship retry, the ticket does not run on the host');
  });

  const changedWhileDeciding: Array<readonly [string, (ticketId: number) => void]> = [
    ['the ticket left ship', (tid) => { store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(tid); }],
    ['the ticket paused', (tid) => { pauseTicket(store, tid); }],
    ['autopilot stopped after this round', (tid) => { setAutopilotStopAfter(store, tid); }],
    ['autopilot paused', (tid) => { setAutopilotPaused(store, tid, 'auto-fix paused: sandbox read-only'); }],
    ['autopilot stopped', (tid) => { setAutopilotStopped(store, tid, 'auto-fix stopped: ci 3/3'); }],
    ['the ship stage started running', (tid) => { setStage(store, tid, 'ship', { status: 'running' }); }],
    ['a block landed on the ship stage', (tid) => {
      parkGateStage(store, { ticketId: tid, stageKey: 'ship', kind: 'push-diverged', reason: 'diverged', runAt: ENDED, gates: [] });
    }],
    ['a newer ship run exists', (tid) => {
      const run = openShipRun(store, { ticketId: tid, attempt: 2, startedAt: '2026-11-25T11:59:30.000Z' });
      closeShipRun(store, run.id, 'interrupted', '2026-11-25T11:59:45.000Z');
    }],
    ['the ship stage row is gone', (tid) => { removeStage(store, tid, 'ship'); }],
    ['autopilot turned off', (tid) => { setAutopilotOverride(store, tid, 'off'); }],
    ['a session started', (tid) => { setAgentState(store, tid, 'running'); }],
  ];
  for (const [what, change] of changedWhileDeciding) {
    it(`keeps the retry off when ${what} while the decision awaits git`, async () => {
      failedServerErrorShip();
      const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
      const r = retry({
        retryShip,
        shipRetry: {
          worktreeClean: async () => { change(id); return { ok: true as const, clean: true }; },
          localHead: async () => HEAD,
        },
      });
      expect((await autopilotTick(r.deps)).kind).toBe('idle');
      expect(retryShip).not.toHaveBeenCalled();
      expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: no ship retry, the ticket changed while the decision awaited git');
    });
  }

  it('keeps the retry off when a session starts or the host drains while the decision awaits git', async () => {
    for (const change of ['session', 'drain'] as const) {
      failedServerErrorShip();
      let live = false;
      const worktreeClean = async (): Promise<{ ok: true; clean: boolean }> => {
        live = true;
        return { ok: true, clean: true };
      };
      const r = retry({
        ...(change === 'session' ? { sessionRunning: () => live } : {}),
        ...(change === 'drain' ? { isDraining: () => live } : {}),
        shipRetry: { worktreeClean, localHead: async () => HEAD },
      });
      expect((await autopilotTick(r.deps)).kind).toBe('idle');
      expect(r.retryShip).not.toHaveBeenCalled();
    }
  });

  it('never retries a ticket that does not run on the host: its ship would pull sandbox commits', async () => {
    failedServerErrorShip();
    const sandboxed = retry({ placement: async () => 'sandbox' as const });
    expect((await autopilotTick(sandboxed.deps)).kind).toBe('idle');
    expect((await autopilotTick(sandboxed.deps)).kind).toBe('idle');
    expect(sandboxed.retryShip).not.toHaveBeenCalled();
    expect(sandboxed.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: no ship retry, the ticket does not run on the host');
    expect(sandboxed.debug.mock.calls.filter(([m]) => String(m).includes('does not run on the host')).length).toBe(1);
    const unknown = retry({ placement: async () => { throw new Error('no placement is recorded'); } });
    expect((await autopilotTick(unknown.deps)).kind).toBe('idle');
    expect(unknown.retryShip).not.toHaveBeenCalled();
  });

  it('waits before the backoff, with one debug line per armed wait', async () => {
    failedServerErrorShip();
    const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
    const r = rig({ now: () => Date.parse('2026-11-25T12:00:30.000Z'), retryShip, ...retrySeams });
    expect((await autopilotTick(r.deps)).kind).toBe('idle');
    expect((await autopilotTick(r.deps)).kind).toBe('idle');
    expect(retryShip).not.toHaveBeenCalled();
    expect(r.debug).toHaveBeenCalledWith(`[ship] autopilot ticket AP-1: the ship retry waits until ${new Date(Date.parse(ENDED) + 120_000).toISOString()}`);
    expect(r.debug.mock.calls.filter(([m]) => String(m).includes('the ship retry waits')).length).toBe(1);
  });

  it('waits once per ticket, even when two tickets share a store and one wait time', async () => {
    const id2 = createTicket(store, { key: 'AP-2', title: 't2' }).id;
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id2, from, { kind: 'passed' });
    failedServerErrorShip();
    failedServerErrorShip(1, ENDED, id2);
    const now = (): number => Date.parse('2026-11-25T12:00:30.000Z');
    const first = rig({ now, retryShip: vi.fn(), ...retrySeams });
    const second = rig({ ticketId: id2, key: 'AP-2', now, retryShip: vi.fn(), ...retrySeams });
    await autopilotTick(first.deps);
    await autopilotTick(second.deps);
    const waits = (r: Rig) => r.debug.mock.calls.filter(([m]) => String(m).includes('the ship retry waits')).length;
    expect([waits(first), waits(second)]).toEqual([1, 1]);
    expect(second.debug).toHaveBeenCalledWith(expect.stringContaining('ticket AP-2: the ship retry waits'));
  });

  it('stops after 5 retries: one persisted event per failed run, no block, no sixth retry', async () => {
    // The stop line is deduped from the STORE, so the note must really write an event: this ticket lives in a project.
    const project = upsertProject(store, { slug: 'ap-stop' });
    store.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(project.id, id);
    const events = (): number => (store.db.prepare('SELECT COUNT(*) AS n FROM karst_events WHERE ticket_id = ?').get(id) as { n: number }).n;
    const note = (title: string, body: string): void => {
      recordEvent(store, { projectId: project.id, ticketId: id, level: 'error', source: 'autopilot', title, body }, () => {});
    };
    failedServerErrorShip(6);
    const at = Date.parse('2026-11-25T12:59:00.000Z');
    const first = retry({ now: () => at, note });
    expect((await autopilotTick(first.deps)).kind).toBe('idle');
    expect((await autopilotTick(retry({ now: () => at, note }).deps)).kind).toBe('idle');
    expect(first.retryShip).not.toHaveBeenCalled();
    expect(stageBlock(store, id, 'ship')).toBeNull();
    expect(events()).toBe(1);
    expect(first.debug).toHaveBeenCalledWith(`[ship] autopilot ticket AP-1: ${AUTO_SHIP_RETRY_STOP_REASON}; no block, Retry ship stays`);
    expect((store.db.prepare('SELECT body FROM karst_events WHERE ticket_id = ?').get(id) as { body: string }).body)
      .toContain('(ship run ');
    // A newer run exists (a person's ship): a later series of failures writes its own stop event.
    passedRun('2026-11-25T13:00:00.000Z');
    failedServerErrorShip(6, '2026-11-25T13:10:00.000Z');
    const later = retry({ now: () => Date.parse('2026-11-25T13:20:00.000Z'), note });
    expect((await autopilotTick(later.deps)).kind).toBe('idle');
    expect((await autopilotTick(later.deps)).kind).toBe('idle');
    expect(events()).toBe(2);
  });

  it('records the decision refusal once, not on every tick', async () => {
    failedServerErrorShip();
    const r = retry({ shipRetry: { worktreeClean: async () => ({ ok: true as const, clean: false }), localHead: async () => HEAD } });
    expect((await autopilotTick(r.deps)).kind).toBe('idle');
    expect((await autopilotTick(r.deps)).kind).toBe('idle');
    expect(r.retryShip).not.toHaveBeenCalled();
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: no ship retry (the worktree of r has uncommitted changes)');
    expect(r.debug.mock.calls.filter(([m]) => String(m).includes('no ship retry')).length).toBe(1);
  });

  it('throttles the refusal per ticket: two tickets each report their own reason', async () => {
    const id2 = createTicket(store, { key: 'AP-3', title: 't3' }).id;
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id2, from, { kind: 'passed' });
    failedServerErrorShip();
    failedServerErrorShip(1, ENDED, id2);
    const dirty = { worktreeClean: async () => ({ ok: true as const, clean: false }), localHead: async () => HEAD };
    const first = rig({ now: () => AT, retryShip: vi.fn(), shipRetry: dirty });
    const second = rig({ ticketId: id2, key: 'AP-3', now: () => AT, retryShip: vi.fn(), shipRetry: dirty });
    await autopilotTick(first.deps);
    await autopilotTick(second.deps);
    expect(first.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: no ship retry (the worktree of r has uncommitted changes)');
    expect(second.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-3: no ship retry (the worktree of r has uncommitted changes)');
  });

  it('keeps the retry off while any stop reason is on record', async () => {
    failedServerErrorShip();
    setAutopilotStopped(store, id, 'auto-fix stopped: ci 3/3');
    const r = retry();
    expect((await autopilotTick(r.deps)).kind).toBe('idle');
    expect(r.retryShip).not.toHaveBeenCalled();
    expect(r.debug.mock.calls.filter(([m]) => String(m).includes('ship retry')).length).toBe(0);
  });

  it('pauses when the retry opens no run, so a throwing saga never repeats every tick', async () => {
    failedServerErrorShip();
    const retryShip = vi.fn(async () => ({ kind: 'failed' as const, reason: 'the sandbox is out of sync' }));
    const r = retry({ retryShip });
    expect((await autopilotTick(r.deps)).kind).toBe('parked');
    expect(getAutopilotTicket(store, id).pausedReason).toBe('auto-fix stopped: ship retry could not run (the sandbox is out of sync)');
    expect(getAutopilotTicket(store, id).stoppedReason).toBe('auto-fix stopped: ship retry could not run (the sandbox is out of sync)');
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: auto-fix stopped: ship retry could not run (the sandbox is out of sync); paused');
    expect(stageBlock(store, id, 'ship')).toBeNull();
    expect(r.notes).toEqual([[
      'Autopilot: auto-fix stopped: ship retry could not run (the sandbox is out of sync)',
      'AP-1: the ship retry did not open a run; the failed ship keeps its Retry ship. Start it by hand, then set the auto-fix mode again.',
    ]]);
    // Paused: the next tick does not touch it again.
    await autopilotTick(r.deps);
    expect(retryShip).toHaveBeenCalledTimes(1);
  });

  it('counts a retry that failed after opening its run as sent', async () => {
    failedServerErrorShip();
    const retryShip = vi.fn(async () => {
      // The saga opened its run and then failed: the run history bounds the next attempt.
      const run = openShipRun(store, { ticketId: id, attempt: 2, startedAt: '2026-11-25T12:09:00.000Z' });
      const step = openShipRepoStep(store, { shipRunId: run.id, repo: 'r', step: 'pr', detail: 'run', startedAt: '2026-11-25T12:09:00.000Z' });
      finishShipRepoStep(store, step.id, { status: 'failed', detail: 'gh: HTTP 502 Bad Gateway', endedAt: '2026-11-25T12:09:30.000Z' });
      closeShipRun(store, run.id, 'failed', '2026-11-25T12:09:30.000Z');
      return { kind: 'failed' as const, reason: 'ship failed for 1 repo(s)' };
    });
    const r = retry({ retryShip });
    expect((await autopilotTick(r.deps)).kind).toBe('shipRetried');
    expect(getAutopilotTicket(store, id).pausedReason).toBeNull();
    expect(r.notes[0]![0]).toBe('Autopilot: retried ship after a GitHub server error (1/5)');
  });

  it('reports busy when the host drains, and records no event', async () => {
    failedServerErrorShip();
    const r = retry({ retryShip: vi.fn(async () => ({ kind: 'busy' as const })) });
    expect((await autopilotTick(r.deps)).kind).toBe('busy');
    expect(r.notes).toEqual([]);
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: no ship retry, the ship could not start (the host drains or another window holds the ticket)');
  });

  it('works only a failed, unblocked stage: a passed stage and a blocked failed stage stay quiet', async () => {
    setStage(store, id, 'ship', { status: 'passed', blockedKind: null, blockedReason: null, blockedAt: null });
    const passed = retry();
    expect((await autopilotTick(passed.deps)).kind).toBe('idle');
    expect(passed.debug).not.toHaveBeenCalled();
    failedServerErrorShip();
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'push-diverged', reason: 'diverged', runAt: ENDED, gates: [] });
    const blocked = retry();
    expect((await autopilotTick(blocked.deps)).kind).toBe('idle');
    expect(blocked.debug.mock.calls.filter(([m]) => String(m).includes('ship retry')).length).toBe(0);
  });

  it('does not retry when the stage row or the seams are missing, with the off mode, another controller, a session, or a pause', async () => {
    failedServerErrorShip();
    const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
    const base = { now: () => AT, retryShip, ...retrySeams };
    removeStage(store, id, 'ship');
    expect((await autopilotTick(rig(base).deps)).kind).toBe('idle');
    ensureStage(store, id, 'ship');
    failedServerErrorShip();
    expect((await autopilotTick(rig({ ...base, config: () => ({ ...CFG, enabled: false }) }).deps)).kind).toBe('off');
    expect((await autopilotTick(rig({ ...base, controls: () => false }).deps)).kind).toBe('not-controller');
    expect((await autopilotTick(rig({ ...base, sessionRunning: () => true }).deps)).kind).toBe('busy');
    setAutopilotPaused(store, id, 'auto-fix paused: sandbox read-only');
    expect((await autopilotTick(rig(base).deps)).kind).toBe('idle');
    setAutopilotOverride(store, id, 'on');
    expect((await autopilotTick(rig({ now: () => AT, retryShip }).deps)).kind).toBe('idle');
    expect(retryShip).not.toHaveBeenCalled();
    // An absent seam means "not wired yet", never a failed attempt: no pause and no stop reason.
    expect(getAutopilotTicket(store, id).pausedReason).toBeNull();
    expect(getAutopilotTicket(store, id).stoppedReason).toBeNull();
  });
});
