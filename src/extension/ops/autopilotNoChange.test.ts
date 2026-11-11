import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { clearCiRoundHeadShas, getAutopilotRerun, getCiRoundHeadSha, markAutopilotRerun, setCiRoundHeadSha, takeAutopilotAttempt } from '../../store/autopilot.js';
import { RERUN_SETTLE_MS, type FailedCheck, type RerunContext } from './autopilotRerun.js';
import { NO_CHANGE_PATTERN, noChangeStep, recordCiRoundHeads } from './autopilotNoChange.js';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER = '1111111111111111111111111111111111111111';
let store: Store;
let id: number;
let clock = 1_000_000;

const check = (name: string, repo = 'r', run = '100', job = '200'): FailedCheck => ({
  repo, cwd: `/w/${repo}`, name, url: `https://github.com/o/${repo}/actions/runs/${run}/job/${job}`,
});

function ctx(o: { sha?: string | Error; rerun?: Error } = {}) {
  const notes: Array<[string, string]> = [];
  const readRunHeadSha = vi.fn(async (_cwd: string, _c?: unknown) => { if (o.sha instanceof Error) throw o.sha; return o.sha ?? SHA; });
  const rerunFailedJobs = vi.fn(async (_cwd: string, _c?: unknown) => { if (o.rerun) throw o.rerun; });
  const debug = vi.fn();
  const c: RerunContext = {
    store, ticketId: id, key: 'AP-1', now: () => clock, note: (t, b) => void notes.push([t, b]), debug,
    seams: { readJobLog: async () => '', readRunHeadSha, rerunFailedJobs },
  };
  return { c, notes, debug, readRunHeadSha, rerunFailedJobs };
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'AP-1', title: 't' }).id;
  clock = 1_000_000;
  takeAutopilotAttempt(store, id, 'r', 'ci', 'A', 3);
});

describe('ci round head sha (store)', () => {
  it('is null before a round and reads back what a round recorded', () => {
    expect(getCiRoundHeadSha(store, id, 'r')).toBeNull();
    setCiRoundHeadSha(store, id, 'r', SHA);
    expect(getCiRoundHeadSha(store, id, 'r')).toBe(SHA);
    setCiRoundHeadSha(store, id, 'r', null);
    expect(getCiRoundHeadSha(store, id, 'r')).toBeNull();
  });

  it('keeps the attempt count and is kept when the budget row is written again', () => {
    setCiRoundHeadSha(store, id, 'r', SHA);
    takeAutopilotAttempt(store, id, 'r', 'ci', 'A', 3);
    expect(getCiRoundHeadSha(store, id, 'r')).toBe(SHA);
  });
});

describe('clearCiRoundHeadShas', () => {
  it('clears the head of every ci budget of the ticket', () => {
    takeAutopilotAttempt(store, id, 'r2', 'ci', 'A', 3);
    setCiRoundHeadSha(store, id, 'r', SHA);
    setCiRoundHeadSha(store, id, 'r2', SHA);
    clearCiRoundHeadShas(store, id);
    expect([getCiRoundHeadSha(store, id, 'r'), getCiRoundHeadSha(store, id, 'r2')]).toEqual([null, null]);
  });
});

describe('recordCiRoundHeads', () => {
  it('records the head sha of the failing run per repo', async () => {
    const x = ctx();
    await recordCiRoundHeads(x.c, [check('A'), check('B', 'r', '100', '201')]);
    expect(getCiRoundHeadSha(store, id, 'r')).toBe(SHA);
    expect(x.readRunHeadSha).toHaveBeenCalledTimes(1);
  });

  it('records nothing and does not throw when gh fails', async () => {
    const x = ctx({ sha: new Error('gh down') });
    await recordCiRoundHeads(x.c, [check('A')]);
    expect(getCiRoundHeadSha(store, id, 'r')).toBeNull();
    expect(x.debug).toHaveBeenCalledWith(expect.stringContaining('gh down'));
  });

  it('skips a check with no run url', async () => {
    const x = ctx();
    await recordCiRoundHeads(x.c, [{ ...check('A'), url: null }]);
    expect(x.readRunHeadSha).not.toHaveBeenCalled();
  });
});

describe('noChangeStep', () => {
  it('does nothing when no round recorded a head sha', async () => {
    const x = ctx();
    expect(await noChangeStep(x.c, [check('A')])).toEqual({ kind: 'none' });
    expect(x.readRunHeadSha).not.toHaveBeenCalled();
  });

  it('does nothing when the run head differs from the recorded head (a new commit)', async () => {
    setCiRoundHeadSha(store, id, 'r', OTHER);
    const x = ctx();
    expect(await noChangeStep(x.c, [check('A')])).toEqual({ kind: 'none' });
    expect(x.rerunFailedJobs).not.toHaveBeenCalled();
  });

  it('re-runs once on an unchanged head, writes the marker first, and writes one note', async () => {
    setCiRoundHeadSha(store, id, 'r', SHA);
    const x = ctx();
    x.rerunFailedJobs.mockImplementationOnce(async () => {
      expect(getAutopilotRerun(store, id, 'r', '100', 'A')?.pattern).toBe(NO_CHANGE_PATTERN);
    });
    expect(await noChangeStep(x.c, [check('A')])).toEqual({ kind: 'rerun' });
    expect(x.rerunFailedJobs).toHaveBeenCalledTimes(1);
    expect(getAutopilotRerun(store, id, 'r', '100', 'A')).toEqual({ repo: 'r', runId: '100', checkName: 'A', headSha: SHA, pattern: 'no-change', rerunAt: clock });
    expect(x.notes).toEqual([[
      'Autopilot: A abcdef012 re-run once: the ci round made no commit',
      'AP-1: A abcdef012 re-run once: the ci round made no commit in r. It used no attempt.',
    ]]);
  });

  it('re-runs a run once for several checks of that run', async () => {
    setCiRoundHeadSha(store, id, 'r', SHA);
    const x = ctx();
    await noChangeStep(x.c, [check('A'), check('B', 'r', '100', '201')]);
    expect(x.rerunFailedJobs).toHaveBeenCalledTimes(1);
    expect(x.notes).toHaveLength(2);
  });

  it('waits while the re-run settles and does not re-run again (marker survives a reload)', async () => {
    setCiRoundHeadSha(store, id, 'r', SHA);
    markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'A', headSha: SHA, pattern: NO_CHANGE_PATTERN, rerunAt: clock - RERUN_SETTLE_MS + 1 });
    const x = ctx();
    expect(await noChangeStep(x.c, [check('A')])).toEqual({ kind: 'rerun' });
    expect(x.rerunFailedJobs).not.toHaveBeenCalled();
  });

  it('stops after the settle time when the check failed again on the same head', async () => {
    setCiRoundHeadSha(store, id, 'r', SHA);
    markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'A', headSha: SHA, pattern: NO_CHANGE_PATTERN, rerunAt: clock - RERUN_SETTLE_MS });
    const x = ctx();
    expect(await noChangeStep(x.c, [check('A')])).toEqual({ kind: 'stopped', check: 'A' });
    expect(x.rerunFailedJobs).not.toHaveBeenCalled();
  });

  it('stops, with no second re-run, when a network re-run already used this run and the round made no commit', async () => {
    setCiRoundHeadSha(store, id, 'r', SHA);
    markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'A', headSha: SHA, pattern: 'econnreset', rerunAt: clock - RERUN_SETTLE_MS });
    const x = ctx();
    expect(await noChangeStep(x.c, [check('A')])).toEqual({ kind: 'stopped', check: 'A' });
    expect(x.rerunFailedJobs).not.toHaveBeenCalled();
  });

  it('leaves a check that a stale rebase marked to its own step', async () => {
    setCiRoundHeadSha(store, id, 'r', SHA);
    markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'A', headSha: SHA, pattern: 'stale-generated:npm run -s docs:graph', rerunAt: clock - RERUN_SETTLE_MS });
    const x = ctx();
    expect(await noChangeStep(x.c, [check('A')])).toEqual({ kind: 'none' });
    expect(x.readRunHeadSha).not.toHaveBeenCalled();
  });

  it('returns the gh reason when the head read fails', async () => {
    setCiRoundHeadSha(store, id, 'r', SHA);
    const x = ctx({ sha: new Error('gh down') });
    expect(await noChangeStep(x.c, [check('A')])).toEqual({ kind: 'error', reason: 'gh down' });
  });

  it('returns the gh reason when the re-run fails, and forgets nothing it did not do', async () => {
    setCiRoundHeadSha(store, id, 'r', SHA);
    const x = ctx({ rerun: new Error('rerun refused') });
    expect(await noChangeStep(x.c, [check('A')])).toEqual({ kind: 'error', reason: 'rerun refused' });
    expect(x.notes).toEqual([]);
    // No re-run happened: no marker stays, so a Retry may re-run.
    expect(getAutopilotRerun(store, id, 'r', '100', 'A')).toBeNull();
  });
});
