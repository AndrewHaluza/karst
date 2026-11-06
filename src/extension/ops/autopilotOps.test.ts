import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { clearMergeCheck, setMergeCheck } from '../../store/mergeChecks.js';
import { getAutopilotBudget, getAutopilotTicket, setAutopilotOverride, setAutopilotPaused, setAutopilotStopAfter } from '../../store/autopilot.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { allChecksAllowed, approveOneMore, autopilotTick, stopAutopilot, type AutopilotDeps, type FixOutcome } from './autopilotOps.js';

let store: Store;
let id: number;

const CFG: AutopilotConfig = {
  enabled: true,
  conflicts: { policy: 'auto', maxRounds: 2 },
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
function conflict(baseSha: string | null = 'base1'): void {
  setMergeCheck(store, { ticketId: id, repo: 'r', state: 'conflicted', files: ['a.ts'], reason: null, headSha: 'h', baseSha, baseRef: 'develop', checkedAt: '2026-01-01T00:00:00Z' });
}

interface Rig { deps: AutopilotDeps; notes: Array<[string, string]>; debug: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn>; sendCi: ReturnType<typeof vi.fn> }
function rig(over: Partial<AutopilotDeps> = {}, outcome: FixOutcome = { kind: 'sent' }): Rig {
  const notes: Array<[string, string]> = [];
  const debug = vi.fn();
  const resolve = vi.fn(async () => outcome);
  const sendCi = vi.fn(async () => outcome);
  const deps: AutopilotDeps = {
    store, ticketId: id, key: 'AP-1', config: () => CFG,
    controls: () => true, sessionRunning: () => false, concurrencyFull: () => false,
    resolveConflicts: resolve, sendCiFailure: sendCi,
    note: (t, b) => void notes.push([t, b]), debug, ...over,
  };
  return { deps, notes, debug, resolve, sendCi };
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'AP-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
});

describe('allChecksAllowed', () => {
  it('needs every failing name on a non-empty allowlist', () => {
    expect(allChecksAllowed(['a'], ['a', 'b'])).toBe(true);
    expect(allChecksAllowed(['a', 'c'], ['a', 'b'])).toBe(false);
    expect(allChecksAllowed(['a'], [])).toBe(false);
    expect(allChecksAllowed([], ['a'])).toBe(false);
  });
});

describe('autopilotTick gating', () => {
  it('is off by default, when the manifest block is missing, or when the ticket override is off', async () => {
    seedPr(); conflict();
    const r = rig({ config: () => ({ ...CFG, enabled: false }) });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'off' });
    expect(await autopilotTick(rig({ config: () => undefined }).deps)).toEqual({ kind: 'off' });
    setAutopilotOverride(store, id, 'off');
    expect(await autopilotTick(rig().deps)).toEqual({ kind: 'off' });
    setAutopilotOverride(store, id, 'on');
    expect((await autopilotTick(rig({ config: () => ({ ...CFG, enabled: false }) }).deps)).kind).toBe('armed');
  });

  it('does nothing while a session runs, in another window, or when the concurrency limit is full', async () => {
    seedPr(); conflict();
    expect((await autopilotTick(rig({ sessionRunning: () => true }).deps)).kind).toBe('busy');
    const other = rig({ controls: () => false });
    expect((await autopilotTick(other.deps)).kind).toBe('not-controller');
    expect(other.resolve).not.toHaveBeenCalled();
    expect((await autopilotTick(rig({ concurrencyFull: () => true }).deps)).kind).toBe('queued');
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
  });

  it('never acts on a closed PR, a pending or unknown CI, or a conflict with no base head', async () => {
    seedPr(failing('build'), 'closed'); conflict();
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
    store.db.prepare('DELETE FROM prs').run();
    clearMergeCheck(store, id, 'r');
    seedPr({ ...failing('build'), state: 'pending' });
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
    store.db.prepare('DELETE FROM prs').run();
    seedPr({ ...failing('build'), state: 'unknown', failing: [] });
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
  });

  it('two windows never arm the same round: only the controller acts, and a running session blocks the rest', async () => {
    seedPr(); conflict();
    const a = rig({ controls: () => true });
    const b = rig({ controls: () => false });
    const [ra, rb] = [await autopilotTick(a.deps), await autopilotTick(b.deps)];
    expect([ra.kind, rb.kind]).toEqual(['armed', 'not-controller']);
    expect(a.resolve).toHaveBeenCalledTimes(1);
    expect(b.resolve).not.toHaveBeenCalled();
  });
});

describe('conflicts', () => {
  it('arms Resolve conflicts, writes a note and an autopilot debug line', async () => {
    seedPr(); conflict();
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'armed', problem: 'conflicts', used: 1, max: 2 });
    expect(r.resolve).toHaveBeenCalledWith('r');
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(r.notes).toHaveLength(1);
    expect(r.debug.mock.calls[0]![0]).toMatch(/^\[ship\] autopilot /);
  });

  it('honours the ask policy', async () => {
    seedPr(); conflict();
    const r = rig({ config: () => ({ ...CFG, conflicts: { policy: 'ask', maxRounds: 2 } }) });
    expect((await autopilotTick(r.deps)).kind).toBe('ask');
    expect(r.resolve).not.toHaveBeenCalled();
  });

  it('parks with "auto-fix stopped: conflicts 2/2" once the budget is spent, with ONE note across repeat ticks', async () => {
    seedPr(); conflict();
    await autopilotTick(rig().deps); await autopilotTick(rig().deps);
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix stopped: conflicts 2/2' });
    await autopilotTick(r.deps);
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.notes).toHaveLength(1);
  });

  it('resets the counter when the base head moves', async () => {
    seedPr(); conflict('base1');
    await autopilotTick(rig().deps); await autopilotTick(rig().deps);
    conflict('base2');
    expect(await autopilotTick(rig().deps)).toMatchObject({ kind: 'armed', used: 1 });
  });

  it('approve-one-more grants one more attempt, records a note, and does not reset', async () => {
    seedPr(); conflict();
    await autopilotTick(rig().deps); await autopilotTick(rig().deps); await autopilotTick(rig().deps);
    const notes: string[] = [];
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: (t) => void notes.push(t), debug: () => {} }, 'r', 'conflicts');
    expect(notes).toHaveLength(1);
    expect(await autopilotTick(rig().deps)).toMatchObject({ kind: 'armed', used: 3, max: 3 });
    expect((await autopilotTick(rig().deps)).kind).toBe('parked');
  });
});

describe('ci', () => {
  it('sends the failure to the agent for an allowlisted check', async () => {
    seedPr(failing('build'));
    const r = rig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
    expect(r.sendCi).toHaveBeenCalledTimes(1);
    expect(r.resolve).not.toHaveBeenCalled();
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

  it('resets when a different set of checks fails, and counts a repeat of the same set', async () => {
    seedPr(failing('build'));
    await autopilotTick(rig().deps);
    await autopilotTick(rig().deps);
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(2);
    store.db.prepare('UPDATE prs SET checks = ?').run(JSON.stringify(failing('build', 'lint')));
    await autopilotTick(rig().deps);
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
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
});

describe('sandboxed ticket', () => {
  it('(c) an environment blocker pauses at once, costs no attempt, and is not retried', async () => {
    seedPr(); conflict();
    const r = rig({}, { kind: 'env-blocker', reason: 'is read-only' });
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'parked', reason: 'auto-fix paused: sandbox is read-only' });
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').attempts).toBe(0);
    expect(getAutopilotTicket(store, id).pausedReason).toBe('auto-fix paused: sandbox is read-only');
    expect((await autopilotTick(r.deps)).kind).toBe('idle');
    expect(r.resolve).toHaveBeenCalledTimes(1);
    expect(r.notes).toHaveLength(1);
  });

  it('(b) a round the sandbox cannot run parks with the reason and never reaches a host fallback', async () => {
    seedPr(); conflict();
    const r = rig({}, { kind: 'failed', reason: 'sandbox placement unknown' });
    const out = await autopilotTick(r.deps);
    expect(out).toMatchObject({ kind: 'parked' });
    expect(r.resolve).toHaveBeenCalledTimes(1);
    expect(r.notes[0]![1]).toMatch(/sandbox placement unknown/);
  });

  it('a person clears the pause by changing the override', async () => {
    seedPr(); conflict();
    await autopilotTick(rig({}, { kind: 'env-blocker', reason: 'dependency setup failed' }).deps);
    setAutopilotOverride(store, id, 'on');
    expect((await autopilotTick(rig().deps).then((x) => x.kind))).toBe('armed');
  });
});

describe('stopAutopilot', () => {
  const deps = (stopSession: () => Promise<void>) => ({ store, ticketId: id, key: 'AP-1', note: () => {}, debug: () => {}, stopSession });

  it('after-round arms nothing new and does not end the session', async () => {
    seedPr(); conflict();
    const stop = vi.fn(async () => {});
    await stopAutopilot(deps(stop), 'after-round');
    expect(stop).not.toHaveBeenCalled();
    expect((await autopilotTick(rig().deps)).kind).toBe('idle');
  });

  it('(e) now ends the session through the stop seam (which syncs a sandbox before runner.stop)', async () => {
    const order: string[] = [];
    await stopAutopilot(deps(async () => { order.push('sync'); order.push('stop'); }), 'now');
    expect(order).toEqual(['sync', 'stop']);
    expect(getAutopilotTicket(store, id).stopAfter).toBe(true);
  });
});

describe('notes and debug lines (the history matches a manual click)', () => {
  it('records an armed conflict round with its title, body and debug line', async () => {
    seedPr(); conflict();
    const r = rig();
    await autopilotTick(r.deps);
    expect(r.notes).toEqual([['Autopilot: conflicts round 1/2', 'AP-1: ran Resolve conflicts for r (round 1/2).']]);
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 conflicts round 1/2 armed for r');
  });

  it('records an armed CI round as Send CI failure to agent', async () => {
    seedPr(failing('build'));
    const r = rig();
    await autopilotTick(r.deps);
    expect(r.notes).toEqual([['Autopilot: ci round 1/3', 'AP-1: ran Send CI failure to agent for r (round 1/3).']]);
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
    seedPr(); conflict();
    setAutopilotPaused(store, id, 'auto-fix paused: sandbox x');
    expect((await autopilotTick(rig().deps)).kind).toBe('idle');
    setAutopilotOverride(store, id, 'inherit');
    setAutopilotStopAfter(store, id);
    expect((await autopilotTick(rig().deps)).kind).toBe('idle');
  });

  it('only a conflicted check with a recorded base head on an open PR counts', async () => {
    seedPr();
    setMergeCheck(store, { ticketId: id, repo: 'r', state: 'clean', files: [], reason: null, headSha: 'h', baseSha: 'b', baseRef: 'develop', checkedAt: 'x' });
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
    conflict(null);
    expect((await autopilotTick(rig().deps)).kind).toBe('nothing');
  });

  it('an environment pause and a fetch failure both carry the reason in the note and the debug line', async () => {
    seedPr(); conflict();
    const r = rig({}, { kind: 'env-blocker', reason: 'is read-only' });
    await autopilotTick(r.deps);
    expect(r.notes[0]![0]).toBe('Autopilot: auto-fix paused: sandbox is read-only');
    expect(r.notes[0]![1]).toBe('AP-1 (conflicts): the sandbox cannot run a round (is read-only); no attempt was used and the host fallback is never taken.');
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 conflicts: auto-fix paused: sandbox is read-only');
  });

  it('a failed action writes its own note body and does not set the budget-spent reason', async () => {
    seedPr(failing('build'));
    const r = rig({}, { kind: 'failed', reason: 'gh down' });
    await autopilotTick(r.deps);
    expect(r.notes[0]![1]).toBe('AP-1 (ci): the action failed (gh down); the ticket stays in ship and no attempt was used.');
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 ci: auto-fix stopped: ci could not run (gh down)');
  });

  it('the budget-spent note says what to do', async () => {
    seedPr(); conflict();
    await autopilotTick(rig().deps); await autopilotTick(rig().deps);
    const r = rig();
    await autopilotTick(r.deps);
    expect(r.notes[0]).toEqual(['Autopilot: auto-fix stopped: conflicts 2/2', 'AP-1 (conflicts): the budget for r is spent; approve one more attempt or fix it by hand.']);
  });

  it('approve-one-more and stop write exact notes and debug lines', async () => {
    const notes: Array<[string, string]> = [];
    const debug = vi.fn();
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: (t, b) => void notes.push([t, b]), debug }, 'r', 'ci');
    expect(notes[0]).toEqual(['Autopilot: one more ci attempt approved', 'AP-1: r now has 1 extra attempt(s) (0 used).']);
    expect(debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1 ci +1 approved for r');
    const stopNotes: Array<[string, string]> = [];
    const stop = vi.fn(async () => {});
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
