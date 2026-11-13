import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, pauseTicket, setStageCurrent } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { clearConflictRound, getAutopilotRerun, getCiRoundAt, getConflictRoundAt, markConflictRound, getAutopilotBudget, getAutopilotTicket, takeAutopilotAttempt, setCiRoundHeadSha, getCiRoundHeadSha, setAutopilotOverride, setAutopilotPaused, setAutopilotStopAfter, setAutopilotStopped } from '../../store/autopilot.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { sendBackToImplement } from '../../workflow/sendBack.js';
import { allChecksAllowed, approveOneMore, autopilotTick, clearParkBlock, ROUND_LAUNCH_DEATH_WINDOW_MS, roundDied, stopAutopilot, type AutopilotDeps, type FixOutcome } from './autopilotOps.js';

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
