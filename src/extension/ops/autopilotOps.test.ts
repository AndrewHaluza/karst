import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, pauseTicket, setStageCurrent } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { getAutopilotBudget, getAutopilotTicket, takeAutopilotAttempt, setAutopilotOverride, setAutopilotPaused, setAutopilotStopAfter, setAutopilotStopped } from '../../store/autopilot.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { allChecksAllowed, approveOneMore, autopilotTick, stopAutopilot, type AutopilotDeps, type FixOutcome } from './autopilotOps.js';

const NORMAL_BLOCK = 'blocked: the pull request for "r" has changes and is not merged yet.';
let store: Store;
let id: number;

const CFG: AutopilotConfig = {
  enabled: true,
  ci: { policy: 'auto', maxAttempts: 3, checks: ['build', 'lint'] },
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
const PASSING = { state: 'passing', total: 3, passed: 3, failed: 0, pending: 0, failedShown: 0, failing: [] };

interface Rig { deps: AutopilotDeps; notes: Array<[string, string]>; debug: ReturnType<typeof vi.fn>; sendCi: ReturnType<typeof vi.fn> }
function rig(over: Partial<AutopilotDeps> = {}, outcome: FixOutcome = { kind: 'sent' }): Rig {
  const notes: Array<[string, string]> = [];
  const debug = vi.fn();
  const sendCi = vi.fn(async () => outcome);
  const deps: AutopilotDeps = {
    store, ticketId: id, key: 'AP-1', config: () => CFG,
    controls: () => true, sessionRunning: () => false, concurrencyFull: () => false,
    isHostTicket: async () => true, isGraphTicket: () => false, sendCiFailure: sendCi,
    note: (t, b) => void notes.push([t, b]), debug, ...over,
  };
  return { deps, notes, debug, sendCi };
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
    expect((await autopilotTick(r.deps)).kind).toBe('nothing');
    expect(r.sendCi).not.toHaveBeenCalled();
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

describe('sandboxed ticket or unknown placement', () => {
  it.each([
    ['a sandboxed ticket', async () => false],
    ['a placement that cannot be read', async () => { throw new Error('probe failed'); }],
  ])('parks %s with the required reason and a note, uses no attempt, and runs no round', async (_n, isHostTicket) => {
    seedPr(failing('build'));
    const r = rig({ isHostTicket });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix not run: sandboxed ticket' });
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]![0]).toBe('Autopilot: auto-fix not run: sandboxed ticket');
    expect(stageBlock(store, id, 'ship')).toMatchObject({ kind: 'awaiting-merge', reason: 'auto-fix not run: sandboxed ticket' });
    await autopilotTick(r.deps);
    expect(r.notes).toHaveLength(1);
  });

  it('does not park a sandboxed ticket whose failing check is not allowlisted twice: the allowlist park comes first', async () => {
    seedPr(failing('e2e'));
    const r = rig({ isHostTicket: async () => false });
    expect(await autopilotTick(r.deps)).toMatchObject({ reason: expect.stringContaining('is not on the allowlist') });
  });

  it('waits when CI is not failing: a sandboxed ticket with no failure is left alone', async () => {
    seedPr({ ...failing('build'), state: 'pending' });
    const r = rig({ isHostTicket: async () => false });
    expect((await autopilotTick(r.deps)).kind).toBe('nothing');
    expect(r.notes).toHaveLength(0);
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
