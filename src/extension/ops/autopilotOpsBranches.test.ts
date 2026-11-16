import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, setStageCurrent } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { openDeliverRun, recordDeliverGate, finishDeliverRun } from '../../store/deliverRuns.js';
import {
  getAutopilotBudget, getAutopilotTicket, getCiRoundAt, getCiRoundHeadSha, getConflictRoundAt, markConflictRound,
  setAutopilotStopped, setCiRoundHeadSha, takeAutopilotAttempt,
} from '../../store/autopilot.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { allChecksAllowed, approveOneMore, autopilotTick, NO_CHANGE_BASE_MOVED_REASON, roundDied, stopAutopilot, type AutopilotDeps, type FixOutcome } from './autopilotOps.js';

const NORMAL_BLOCK = 'blocked: the pull request for "r" has changes and is not merged yet.';
const STALLED = 'auto-fix stopped: conflict round did not deliver';
const CFG: AutopilotConfig = { enabled: true, ci: { policy: 'auto', maxAttempts: 3, checks: ['build', 'lint'] }, conflicts: { policy: 'auto', maxRounds: 2 } };
let store: Store;
let id: number;

function seedPr(checks: unknown, repo = 'r', number = 5): void {
  store.db.prepare('INSERT OR IGNORE INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, repo, `/w/${repo}`, 'b');
  store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, repo, number, `https://github.com/o/${repo}/pull/${number}`, 'open', checks === null ? null : JSON.stringify(checks));
}
const failing = (...names: string[]) => ({
  state: 'failing', total: 3, passed: 1, failed: names.length, pending: 0, failedShown: names.length,
  failing: names.map((name) => ({ name, url: null })),
});
const PASSING = { state: 'passing', total: 3, passed: 3, failed: 0, pending: 0, failedShown: 0, failing: [] };
const optionalFail = (names: string[]) => ({
  ...failing(...names), required: { total: 2, failed: 0, pending: 0 },
  failing: names.map((name) => ({ name, url: null, required: false })),
});
function mergeRow(repo: string, state: 'clean' | 'conflicted', baseSha: string | null = 'base1'): void {
  setMergeCheck(store, { ticketId: id, repo, state, files: state === 'clean' ? [] : ['a.ts'], reason: null, headSha: 'h', baseSha, baseRef: 'develop', checkedAt: 'x' });
}
function conflict(repo = 'r', baseSha: string | null = 'base1'): void {
  if (repo !== 'r') seedPr(null, repo, 7);
  else store.db.prepare('INSERT OR IGNORE INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, repo, '/w/r', 'b');
  mergeRow(repo, 'conflicted', baseSha);
}

function rig(over: Partial<AutopilotDeps> = {}, outcome: FixOutcome = { kind: 'sent' }) {
  const notes: Array<[string, string]> = [];
  const debug = vi.fn();
  const sendCi = vi.fn(async () => outcome);
  const sendConflict = vi.fn(async (_repo: string) => outcome);
  const sendGate = vi.fn(async () => outcome);
  const deps: AutopilotDeps = {
    store, ticketId: id, key: 'AP-1', config: () => CFG, controls: () => true, sessionRunning: () => false, concurrencyFull: () => false,
    placement: async () => 'host', isGraphTicket: () => false, sendCiFailure: sendCi, sendGateFailure: sendGate, sendConflict,
    conflictRoundActive: () => false, conflictRoundStalled: () => false, dropConflictRound: () => {},
    note: (t, b) => void notes.push([t, b]), debug, ...over,
  };
  return { deps, notes, debug, sendCi, sendConflict, sendGate };
}
const lines = (debug: ReturnType<typeof vi.fn>): string[] => debug.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'AP-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
  parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: NORMAL_BLOCK, runAt: '2026-08-09T10:00:00.000Z', gates: [] });
});

describe('allChecksAllowed edges', () => {
  it('is false for any empty side and true only when every name is listed', () => {
    expect(allChecksAllowed([], [])).toBe(false);
    expect(allChecksAllowed(['a'], ['a'])).toBe(true);
    expect(allChecksAllowed(['a', 'b'], ['a'])).toBe(false);
  });
});

describe('park text and guards', () => {
  it('writes the exact note, debug line and stop reason, and a repeat is quiet', async () => {
    seedPr({ ...failing('build'), failed: 3 });
    const r = rig();
    const reason = 'auto-fix not run: the list of failing ci checks is cut short';
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason });
    expect(r.notes).toEqual([[`Autopilot: ${reason}`, 'AP-1 (ci): the failing check list is cut short, so the allowlist cannot be checked; send the failure to the agent by hand.']]);
    expect(lines(r.debug)).toContain(`[ship] autopilot ticket AP-1 ci: ${reason}`);
    expect(stageBlock(store, id, 'ship')?.reason).toBe(reason);
    expect(getAutopilotTicket(store, id).stoppedReason).toBe(reason);
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'nothing' });
    expect(r.notes).toHaveLength(1);
  });

  it('writes no park when ship has not passed, and says so', async () => {
    setStage(store, id, 'ship', { status: 'pending' });
    seedPr({ ...failing('build'), failed: 3 });
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'idle' });
    expect(r.notes).toEqual([]);
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1 ci: the ticket left ship or ship is not shipped; park "auto-fix not run: the list of failing ci checks is cut short" not written');
  });

  it('writes no park when the ticket left ship during the round', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => { setStageCurrent(store, id, 'impl'); throw new Error('gone'); } });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'idle' });
    expect(r.notes).toEqual([]);
  });

  it('leaves a foreign block untouched', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => { parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'push-diverged', reason: 'diverged', runAt: 'x', gates: [] }); throw new Error('x'); } });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'idle' });
    expect(stageBlock(store, id, 'ship')?.reason).toBe('diverged');
    expect(r.notes).toEqual([]);
  });

  it('parks a placement that cannot be read with the error text', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => { throw new Error('no record'); } });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix not run: placement unknown' });
    expect(r.notes[0]![1]).toBe('AP-1 (ci): the recorded placement cannot be read (no record); autopilot never guesses the environment. Send the failure to the agent by hand.');
  });

  it('parks a non-Error placement rejection by its string', async () => {
    seedPr(failing('build'));
    const r = rig({ placement: async () => Promise.reject('plain') });
    await autopilotTick(r.deps);
    expect(r.notes[0]![1]).toContain('cannot be read (plain)');
  });

  it('parks a graph ticket with the hand-off text', async () => {
    seedPr(failing('build'));
    const r = rig({ isGraphTicket: () => true });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix not run: graph ticket' });
    expect(r.notes[0]![1]).toBe('AP-1 (ci): an active graph run owns the sessions of this ticket, so a hand-off would reach no agent. Retry when the run closes, or send the failure to the agent by hand.');
  });

  it('parks a check that is off the allowlist and a spent budget with exact text', async () => {
    seedPr(failing('build', 'deploy'));
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix not run: ci check deploy is not on the allowlist' });
    expect(r.notes[0]![1]).toBe('AP-1 (ci): a failing check is not on the autopilot allowlist; send the failure to the agent by hand.');
  });

  it('parks a spent CI budget and gives back the attempts taken before it', async () => {
    seedPr(failing('build'));
    seedPr(failing('lint'), 's', 8);
    for (let i = 0; i < 3; i += 1) takeAutopilotAttempt(store, id, 's', 'ci', 'lint', 3);
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci 3/3' });
    expect(r.notes[0]![1]).toBe('AP-1 (ci): the budget for s is spent; approve one more attempt or fix it by hand.');
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(r.sendCi).not.toHaveBeenCalled();
  });
});

describe('optional-only failures', () => {
  it('notes once per signature with exact text and clears a stale park', async () => {
    seedPr(optionalFail(['Opt check one']));
    setAutopilotStopped(store, id, 'auto-fix not run: x');
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'auto-fix not run: x', runAt: 'x', gates: [] });
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'cleared' });
    expect(r.notes).toEqual([['Autopilot: optional ci check failed, no auto-fix', 'AP-1: the failing check Opt check one is optional and not on the autopilot allowlist, and the required checks passed. No round started and the ticket is not parked.']]);
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1 ci: optional check Opt check one failed and is not on the allowlist; no round, no park');
    expect(getAutopilotTicket(store, id).stoppedReason).toBeNull();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'nothing' });
    expect(r.notes).toHaveLength(1);
  });
});

describe('conflict rounds', () => {
  it('arms a conflict round with exact note, debug and store effects', async () => {
    seedPr(null);
    conflict();
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'armed', problem: 'conflicts', used: 1, max: 2 });
    expect(r.notes).toEqual([['Autopilot: conflicts round 1/2', 'AP-1: ran Resolve conflicts for r (round 1/2).']]);
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1 conflicts round 1/2 armed for r');
    expect(getConflictRoundAt(store, id)).not.toBeNull();
    const row = store.db.prepare('SELECT checks FROM prs WHERE ticket_id = ?').get(id) as { checks: string | null };
    expect(row.checks).toBeNull();
  });

  it('takes the repos in name order', async () => {
    conflict('s');
    seedPr(null);
    conflict('r');
    const r = rig();
    await autopilotTick(r.deps);
    expect(r.sendConflict).toHaveBeenCalledWith('r');
  });

  it('goes on to the next repo when the first is spent, and parks with every repo named when all are spent', async () => {
    seedPr(null);
    conflict('r');
    conflict('s');
    for (let i = 0; i < 2; i += 1) takeAutopilotAttempt(store, id, 'r', 'conflicts', 'base1', 2);
    const a = rig();
    expect((await autopilotTick(a.deps)).kind).toBe('armed');
    expect(a.sendConflict).toHaveBeenCalledWith('s');
    for (let i = 0; i < 2; i += 1) takeAutopilotAttempt(store, id, 's', 'conflicts', 'base1', 2);
    store.db.prepare('DELETE FROM autopilot_budgets WHERE ticket_id = ? AND repo = ?').run(id, 'zz');
    const b = rig();
    const result = await autopilotTick(b.deps);
    expect(result).toMatchObject({ kind: 'parked' });
    expect(b.notes.at(-1)![1]).toBe('AP-1 (conflicts): the conflict budget for r, s is spent; approve one more attempt or resolve it by hand.');
  });

  it('asks and logs when the base head is unknown, and the CI path still runs', async () => {
    seedPr(failing('build'));
    conflict('r', null);
    const r = rig();
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1: conflict on r has no known base head; resolve it by hand');
    expect(r.sendCi).toHaveBeenCalledTimes(1);
  });

  it('lets the CI path run when the conflicts policy is ask', async () => {
    seedPr(failing('build'));
    conflict();
    const r = rig({ config: () => ({ ...CFG, conflicts: { ...CFG.conflicts, policy: 'ask' } }) });
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(r.sendConflict).not.toHaveBeenCalled();
  });

  it('queues one waiting round with exact text and gives the attempt back', async () => {
    seedPr(null);
    conflict();
    const r = rig({ concurrencyFull: () => true });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'queued' });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'queued' });
    expect(r.notes).toEqual([['Autopilot: conflicts round is waiting', 'AP-1: the conflicts round for r waits for a free sub-task slot; it starts when one is free.']]);
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1 conflicts round for r is waiting for a free concurrency slot');
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
  });

  it('parks a thrown conflict action, drops the round and keeps no attempt', async () => {
    seedPr(null);
    conflict();
    const drop = vi.fn();
    const r = rig({ dropConflictRound: drop });
    r.sendConflict.mockRejectedValue(new Error('boom'));
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: conflicts could not run (boom)' });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
    expect(r.notes[0]![1]).toBe('AP-1 (conflicts): the action failed (boom); the ticket stays in ship and no attempt was used.');
    expect(getAutopilotTicket(store, id).pausedReason).toBe('auto-fix stopped: conflicts could not run (boom)');
  });

  it('waits for the next probe when the stored conflict is of an older head', async () => {
    seedPr(null);
    conflict();
    const r = rig({ localHead: async () => 'other' });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'nothing' });
    expect(r.sendConflict).not.toHaveBeenCalled();
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1: the conflict row of r is for an older head; no round until the next probe');
  });

  it('treats a matching, null or failing local head as fresh', async () => {
    for (const localHead of [async () => 'h', async () => null, async (): Promise<string | null> => { throw new Error('x'); }]) {
      store.db.prepare('DELETE FROM prs').run();
      store.db.prepare('DELETE FROM autopilot_budgets').run();
      seedPr(null);
      conflict();
      const r = rig({ localHead });
      expect((await autopilotTick(r.deps)).kind).toBe('armed');
      expect(r.sendConflict).toHaveBeenCalledWith('r');
    }
  });
});

describe('resume and stalled rounds', () => {
  it('notes a delivered finished merge, with and without a stored round', async () => {
    seedPr(PASSING);
    const a = rig({ resumeDeliver: async () => 'started' });
    expect(await autopilotTick(a.deps)).toEqual({ kind: 'busy' });
    expect(a.notes[0]![0]).toBe('Autopilot: delivers a finished local merge');
    expect(a.notes[0]![1]).toBe('AP-1: the resolved merge is finished in the worktree but not pushed. Karst runs the gates and pushes it. No new round and no attempt was used.');
    expect(lines(a.debug)).toContain('[ship] autopilot ticket AP-1: delivers a finished local merge; no new conflict round');
    markConflictRound(store, id, Date.now());
    const b = rig({ resumeDeliver: async () => 'started' });
    await autopilotTick(b.deps);
    expect(b.notes[0]![0]).toBe('Autopilot: resumed the auto-deliver after a reload');
  });

  it('passes the stored round flag and goes on when the outcome is wait', async () => {
    seedPr(PASSING);
    const resumeDeliver = vi.fn(async (_f: boolean) => 'wait' as const);
    const r = rig({ resumeDeliver });
    expect((await autopilotTick(r.deps)).kind).toBe('nothing');
    expect(resumeDeliver).toHaveBeenCalledWith(false);
    markConflictRound(store, id, Date.now());
    await autopilotTick(r.deps);
    expect(resumeDeliver).toHaveBeenLastCalledWith(true);
  });

  it('skips the resume while a conflict round is active', async () => {
    seedPr(PASSING);
    const resumeDeliver = vi.fn(async () => 'started' as const);
    const r = rig({ resumeDeliver, conflictRoundActive: () => true });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'busy' });
    expect(resumeDeliver).not.toHaveBeenCalled();
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1: no round, a conflict round is armed or its resolved merge is being delivered');
  });

  it('parks an unfinished merge that a reload ended, and drops the slot', async () => {
    seedPr(PASSING);
    markConflictRound(store, id, Date.now());
    const drop = vi.fn();
    const r = rig({ resumeDeliver: async () => 'unfinished', dropConflictRound: drop });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: STALLED });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(getConflictRoundAt(store, id)).toBeNull();
    expect(r.notes[0]![1]).toBe('AP-1 (conflicts): a window reload ended the round and the merge is not finished. Approve one more attempt or resolve the conflict by hand.');
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1: the conflict round did not survive the reload and its merge is not finished; it is dropped');
  });

  it('goes on without a stored round when the merge is unfinished', async () => {
    seedPr(PASSING);
    const r = rig({ resumeDeliver: async () => 'unfinished' });
    expect((await autopilotTick(r.deps)).kind).toBe('nothing');
  });

  it('drops a stalled engine round with a note', async () => {
    seedPr(PASSING);
    markConflictRound(store, id, Date.now());
    const drop = vi.fn();
    const r = rig({ conflictRoundStalled: () => true, dropConflictRound: drop });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: STALLED });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(getConflictRoundAt(store, id)).toBeNull();
    expect(r.notes[0]![1]).toBe('AP-1 (conflicts): the resolved merge was not delivered (the agent left it unfinished, or a gate failed). The round is dropped; approve one more attempt or resolve the conflict by hand.');
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1: the conflict round did not deliver; it is dropped');
  });
});

describe('proven clean after a stalled round', () => {
  const run = async (checks: unknown, merge: 'clean' | 'conflicted' = 'clean'): Promise<string> => {
    store.db.prepare('DELETE FROM prs').run();
    seedPr(checks);
    mergeRow('r', merge);
    setAutopilotStopped(store, id, STALLED);
    return (await autopilotTick(rig().deps)).kind;
  };

  it('goes on only for positive evidence', async () => {
    expect(await run(PASSING)).not.toBe('idle');
    expect(await run(optionalFail(['x']))).not.toBe('idle');
    expect(await run(null)).toBe('idle');
    expect(await run(PASSING, 'conflicted')).toBe('idle');
    expect(await run({ ...PASSING, state: 'pending', pending: 1 })).toBe('idle');
    expect(await run(failing('build'))).toBe('idle');
    expect(await run({ ...optionalFail(['x']), pending: 1 })).toBe('idle');
    expect(await run({ ...optionalFail(['x']), failed: 2 })).toBe('idle');
    expect(await run({ ...optionalFail(['x']), failing: [], failed: 0 })).toBe('idle');
    expect(await run({ ...optionalFail(['x']), failing: [{ name: 'x', url: null, required: true }] })).toBe('idle');
  });

  it('is idle with no open PR', async () => {
    setAutopilotStopped(store, id, STALLED);
    expect((await autopilotTick(rig().deps)).kind).toBe('idle');
  });
});

describe('base-moved round text and budgets', () => {
  const REASON = 'r: gate "unit" fails when merged with origin/develop 1d1930be8 - FAIL a.test.ts';
  function parkFailed(head: string | null, repos: string[] = ['r']): void {
    setStage(store, id, 'ship', { status: 'pending', verdict: null, endedAt: null, blockedKind: 'base-moved-failed', blockedReason: REASON, blockedAt: 'T0' });
    const runId = openDeliverRun(store, { ticketId: id, headSha: head as string, gates: ['unit'], pid: 1, now: 'T0', kind: 'base-moved' });
    for (const repo of repos) recordDeliverGate(store, runId, { gateName: 'unit', repo, exitCode: 1, summary: 'FAIL', startedAt: null, endedAt: null });
    finishDeliverRun(store, runId, 'failed', 'T1');
  }

  it('arms with exact note and debug, and records the head for every target', async () => {
    parkFailed('head1', ['r', 's']);
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
    expect(r.notes).toEqual([['Autopilot: ci round 1/3', 'AP-1: ran Send gate failure to agent for r (round 1/3).']]);
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1 ci round 1/3 armed for r');
    expect(getCiRoundHeadSha(store, id, 'r')).toBe('head1');
    expect(getCiRoundHeadSha(store, id, 's')).toBe('head1');
    expect(getCiRoundAt(store, id)).not.toBeNull();
  });

  it('records no head when the action fails', async () => {
    parkFailed('head1');
    const r = rig({}, { kind: 'failed', reason: 'nope' });
    expect((await autopilotTick(r.deps)).kind).toBe('parked');
    expect(getCiRoundHeadSha(store, id, 'r')).toBeNull();
    expect(r.notes[0]![1]).toBe('AP-1 (ci): the action failed (nope); the ticket stays in ship and no attempt was used.');
  });

  it('parks when any one target already ran on this head, with the no-change text', async () => {
    parkFailed('head1', ['r', 's']);
    await autopilotTick(rig().deps);
    setCiRoundHeadSha(store, id, 'r', 'other');
    parkFailed('head1', ['r', 's']);
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: NO_CHANGE_BASE_MOVED_REASON });
    expect(r.notes[0]![1]).toBe('AP-1 (ci): the agent made no commit and the base-moved check failed again on the same head; fix it by hand or approve one more attempt.');
    expect(r.sendGate).not.toHaveBeenCalled();
  });

  it('queues with one note, takes no attempt, and a thrown action parks with the string', async () => {
    parkFailed('head1');
    const q = rig({ concurrencyFull: () => true });
    expect(await autopilotTick(q.deps)).toEqual({ kind: 'queued' });
    await autopilotTick(q.deps);
    expect(q.notes).toEqual([['Autopilot: ci round is waiting', `AP-1: the ci round for r waits for a free sub-task slot; it starts when one is free.`]]);
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    const t = rig();
    t.sendGate.mockRejectedValue('plain');
    expect(await autopilotTick(t.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci could not run (plain)' });
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
  });

  it('parks a spent target after giving back the attempts taken before it', async () => {
    parkFailed('head1', ['r', 's']);
    for (let i = 0; i < 3; i += 1) takeAutopilotAttempt(store, id, 's', 'ci', REASON, 3);
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: ci 3/3' });
    expect(r.notes[0]![1]).toBe('AP-1 (ci): the budget for s is spent; approve one more attempt or fix it by hand.');
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
  });

  it('pauses on a sandbox blocker and gives the attempts back', async () => {
    parkFailed('head1');
    const r = rig({ placement: async () => 'sandbox', sandboxPreflight: async () => 'clone dirty' });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix paused: sandbox clone dirty' });
    expect(r.notes[0]![1]).toBe('AP-1 (ci): the sandbox cannot run the ci round (clone dirty); no attempt was used and the round is not retried. Fix the sandbox, then set the auto-fix mode again.');
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1 ci round for r blocked by the sandbox: clone dirty');
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(getAutopilotTicket(store, id).pausedReason).toBe('auto-fix paused: sandbox clone dirty');
  });

  it('parks an active graph ticket', async () => {
    parkFailed('head1');
    const r = rig({ isGraphTicket: () => true });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix not run: graph ticket' });
  });

  it('logs the drain', async () => {
    parkFailed('head1');
    const r = rig({ isDraining: () => true });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'busy' });
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1: no round, the host drains for a reload');
  });
});

describe('settle outcomes', () => {
  it('a lost lease refunds the attempt and stays quiet', async () => {
    seedPr(failing('build'));
    const r = rig({}, { kind: 'lease-lost' });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'not-controller' });
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(r.notes).toEqual([]);
  });

  it('a sent CI round marks the round, clears the stop reason and the park block, and clears the queue notes', async () => {
    seedPr(failing('build'));
    setAutopilotStopped(store, id, 'auto-fix stopped: old');
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'auto-fix stopped: old', runAt: 'x', gates: [] });
    let full = true;
    const r = rig({ concurrencyFull: () => full });
    await autopilotTick(r.deps);
    full = false;
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
    expect(getCiRoundAt(store, id)).not.toBeNull();
    expect(getAutopilotTicket(store, id).stoppedReason).toBeNull();
    expect(stageBlock(store, id, 'ship')?.reason.startsWith('auto-fix')).toBe(false);
    expect(r.notes.map((n) => n[0])).toEqual(['Autopilot: ci round is waiting', 'Autopilot: ci round 1/3']);
    expect(r.notes[1]![1]).toBe('AP-1: ran Send CI failure to agent for r (round 1/3).');
    full = true;
    store.db.prepare('UPDATE autopilot_budgets SET attempts = 0 WHERE ticket_id = ?').run(id);
    await autopilotTick(r.deps);
    expect(r.notes.map((n) => n[0]).filter((t) => t.endsWith('waiting'))).toHaveLength(2);
  });

  it('a failed CI action that left ship pauses with exact text', async () => {
    seedPr(failing('build'));
    const r = rig();
    r.sendCi.mockImplementation(async () => { setStageCurrent(store, id, 'impl'); return { kind: 'failed', reason: 'boom' } as FixOutcome; });
    const reason = 'auto-fix paused: ci session did not start (boom)';
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason });
    expect(r.notes[0]).toEqual([`Autopilot: ${reason}`, 'AP-1: the ci round for r moved the ticket to Implement but no session started; no attempt was used. Start the agent by hand, then set the auto-fix mode again to resume.']);
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1 ci left ship before the failure: boom');
    expect(getAutopilotTicket(store, id).stoppedReason).toBe(reason);
    expect(getAutopilotTicket(store, id).pausedReason).toBe(reason);
  });

  it('a failed conflict action drops the round', async () => {
    seedPr(null);
    conflict();
    const drop = vi.fn();
    const r = rig({ dropConflictRound: drop }, { kind: 'failed', reason: 'x' });
    await autopilotTick(r.deps);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(getConflictRoundAt(store, id)).toBeNull();
  });
});

describe('roundDied and the commands', () => {
  const deps = (r: ReturnType<typeof rig>, drop = vi.fn()) => ({ store, ticketId: id, key: 'AP-1', note: r.deps.note, debug: r.deps.debug, dropConflictRound: drop });

  it('writes the exact park body for a round still in ship', async () => {
    seedPr(failing('build'));
    const r = rig();
    await autopilotTick(r.deps);
    r.notes.length = 0;
    roundDied(deps(r), 'boom');
    expect(r.notes[0]![1]).toBe('AP-1 (ci): the session of the ci round for r died after launch (boom); the attempt was given back and the round is not retried. Start the agent by hand, then set the auto-fix mode again.');
  });

  it('writes the exact note and debug line for a round that left ship', async () => {
    seedPr(failing('build'));
    const r = rig();
    await autopilotTick(r.deps);
    setStageCurrent(store, id, 'impl');
    r.notes.length = 0;
    const result = roundDied(deps(r), 'boom');
    const reason = 'auto-fix paused: ci session died after launch (boom)';
    expect(result).toEqual({ kind: 'parked', reason });
    expect(r.notes[0]![1]).toBe('AP-1: the session of the ci round for r died after launch (boom); the attempt was given back and the round is not retried.');
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1 ci session died after launch: boom');
    expect(getAutopilotTicket(store, id).stoppedReason).toBe(reason);
    expect(getAutopilotTicket(store, id).pausedReason).toBe(reason);
  });

  it('handles a failure at the window edge and ignores one after it, with the debug text', async () => {
    seedPr(failing('build'));
    const r = rig();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      await autopilotTick(r.deps);
      vi.setSystemTime(1_000_000 + 120_000);
      expect(roundDied(deps(r), 'edge')).not.toBeNull();
      store.db.prepare('DELETE FROM autopilot_budgets').run();
      vi.setSystemTime(2_000_000);
      store.db.prepare("UPDATE autopilot_tickets SET paused_reason = NULL, stopped_reason = NULL WHERE ticket_id = ?").run(id);
      await autopilotTick(rig().deps);
      vi.setSystemTime(2_000_000 + 120_001);
      const q = rig();
      expect(roundDied(deps(q), 'late')).toBeNull();
      expect(lines(q.debug)).toContain('[ship] autopilot ticket AP-1 launch failure ignored: the ci round was sent more than 120s ago');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a conflict round that died drops and clears the slot', async () => {
    seedPr(null);
    conflict();
    const r = rig();
    await autopilotTick(r.deps);
    const drop = vi.fn();
    roundDied(deps(r, drop), 'x');
    expect(drop).toHaveBeenCalledTimes(1);
    expect(getConflictRoundAt(store, id)).toBeNull();
  });

  it('approveOneMore and stopAutopilot write exact notes and debug lines', async () => {
    const r = rig();
    const c = { store, ticketId: id, key: 'AP-1', note: r.deps.note, debug: r.deps.debug };
    approveOneMore(c, 'r', 'ci');
    expect(r.notes[0]).toEqual(['Autopilot: one more ci attempt approved', 'AP-1: r now has 1 extra attempt(s) (0 used).']);
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1 ci +1 approved for r');
    r.notes.length = 0;
    expect(await stopAutopilot({ ...c, stopSession: async () => true }, 'after-round')).toBe('flag-set');
    expect(r.notes[0]).toEqual(['Autopilot: stopped after this round', 'AP-1: a person stopped auto-fix after the current round.']);
    expect(lines(r.debug)).toContain('[ship] autopilot ticket AP-1 stop after-round');
    r.notes.length = 0;
    expect(await stopAutopilot({ ...c, stopSession: async () => true }, 'now')).toBe('ended');
    expect(r.notes[0]).toEqual(['Autopilot: stopped now', 'AP-1: a person stopped auto-fix and ended the session.']);
    r.notes.length = 0;
    expect(await stopAutopilot({ ...c, stopSession: async () => false }, 'now')).toBe('not-reached');
    expect(r.notes[0]![1]).toBe('AP-1: a person stopped auto-fix. The stop did not reach the session: another window holds it, or none is open.');
  });
});
