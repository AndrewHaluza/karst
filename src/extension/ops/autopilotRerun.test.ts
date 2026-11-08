import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { getAutopilotRerun, markAutopilotRerun } from '../../store/autopilot.js';
import { RERUN_SETTLE_MS, transientRerunStep, type FailedCheck, type RerunContext } from './autopilotRerun.js';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const NET = '2026-11-08T10:00:00Z npm error code ECONNRESET\n';
let store: Store;
let id: number;
let clock = 1_000_000;

const check = (name: string, run = '100', job = '200'): FailedCheck => ({ repo: 'r', cwd: '/w/r', name, url: `https://github.com/o/r/actions/runs/${run}/job/${job}` });

function ctx(log: string | Error = NET) {
  const notes: Array<[string, string]> = [];
  const readJobLog = vi.fn(async () => { if (log instanceof Error) throw log; return log; });
  const rerunFailedJobs = vi.fn(async () => {});
  const c: RerunContext = {
    store, ticketId: id, key: 'AP-1', now: () => clock, note: (t, b) => void notes.push([t, b]), debug: vi.fn(),
    seams: { readJobLog, readRunHeadSha: async () => SHA, rerunFailedJobs },
  };
  return { c, notes, readJobLog, rerunFailedJobs };
}

beforeEach(() => { store = openStore(':memory:'); id = createTicket(store, { key: 'AP-1', title: 't' }).id; clock = 1_000_000; });

describe('transientRerunStep', () => {
  it('re-runs a run once for several transient checks of that run and writes one note each', async () => {
    const x = ctx();
    expect(await transientRerunStep(x.c, [check('A'), check('B', '100', '201')])).toEqual({ kind: 'rerun' });
    expect(x.rerunFailedJobs).toHaveBeenCalledTimes(1);
    expect(x.notes.map((n) => n[0])).toEqual([
      'Autopilot: re-ran A on abcdef012 after a network error (econnreset)',
      'Autopilot: re-ran B on abcdef012 after a network error (econnreset)',
    ]);
    expect(x.notes[0]![1]).toBe('AP-1: re-ran A on abcdef012 after a network error (econnreset) in r. It used no attempt.');
    expect(getAutopilotRerun(store, id, 'r', '100', 'A')).toMatchObject({ headSha: SHA, pattern: 'econnreset', rerunAt: clock });
  });

  it('re-runs two runs separately', async () => {
    const x = ctx();
    await transientRerunStep(x.c, [check('A'), check('B', '101', '300')]);
    expect(x.rerunFailedJobs).toHaveBeenCalledTimes(2);
  });

  it('holds for exactly the settle time, then reports the earlier re-run', async () => {
    const x = ctx();
    markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'A', headSha: SHA, pattern: 'econnreset', rerunAt: clock - RERUN_SETTLE_MS + 1 });
    expect(await transientRerunStep(x.c, [check('A')])).toEqual({ kind: 'rerun' });
    clock += 1;
    expect(await transientRerunStep(x.c, [check('A')])).toEqual({ kind: 'none', earlier: new Set(['A']) });
    expect(x.readJobLog).not.toHaveBeenCalled();
  });

  it('does not run when another window already wrote the marker for every check', async () => {
    const x = ctx();
    const c = { ...x.c, seams: { ...x.c.seams, readRunHeadSha: async () => { markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'A', headSha: SHA, pattern: 'econnreset', rerunAt: clock }); return SHA; } } };
    expect(await transientRerunStep(c, [check('A')])).toEqual({ kind: 'rerun' });
    expect(x.rerunFailedJobs).not.toHaveBeenCalled();
    expect(x.notes).toEqual([]);
  });

  it('skips a check without a job url and a check that is not transient', async () => {
    const x = ctx('2026-11-08T10:00:00Z FAIL a.test.ts\n');
    expect(await transientRerunStep(x.c, [{ ...check('A'), url: null }, check('B')])).toEqual({ kind: 'none', earlier: new Set() });
    expect(x.readJobLog).toHaveBeenCalledTimes(1);
  });

  it('reports a gh error from the log, the head or the re-run, and keeps the error text', async () => {
    expect(await transientRerunStep(ctx(new Error('log boom')).c, [check('A')])).toEqual({ kind: 'error', reason: 'log boom' });
    const head = ctx();
    expect(await transientRerunStep({ ...head.c, seams: { ...head.c.seams, readRunHeadSha: async () => { throw new Error('head boom'); } } }, [check('A')])).toEqual({ kind: 'error', reason: 'head boom' });
    const run = ctx();
    run.rerunFailedJobs.mockRejectedValueOnce('plain text');
    expect(await transientRerunStep(run.c, [check('A')])).toEqual({ kind: 'error', reason: 'plain text' });
    expect(run.notes).toEqual([]);
  });
});
