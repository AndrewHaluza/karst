import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { baseRedRuns, getAutopilotRerun, markAutopilotRerun } from '../../store/autopilot.js';
import type { BaseRun } from '../../integrations/ciRerun.js';
import type { FailedCheck } from './autopilotRerun.js';
import { STALE_WAIT_MS } from './autopilotStaleRebase.js';
import { BASE_RED_WAIT_MS, baseRedStep, type BaseRedContext } from './autopilotBaseRed.js';

const PR_HEAD = 'a'.repeat(40);
const RED_SHA = '5d7aef5a5'.padEnd(40, '0');
const GREEN_SHA = 'c'.repeat(40);
const ID = 'dark pages.visual.ts::dashboard/stage-menu-bottom-edge: full-page screenshot';
const PR_LOG = `- ${ID}: 312 pixels (ratio 0.01 of all image pixels) are different\n`;
let store: Store;
let id: number;

const check = (name = 'Visual', repo = 'r', run = '100', base: string | null = 'develop'): FailedCheck => ({
  repo, cwd: `/w/${repo}`, name, base, url: `https://github.com/o/${repo}/actions/runs/${run}/job/200`,
});
const run = (runId: string, conclusion: string, headSha = RED_SHA): BaseRun => ({ runId, headSha, conclusion });

interface Opts {
  prLog?: string | Error;
  runs?: readonly BaseRun[] | Error;
  ids?: Record<string, readonly string[] | null>;
  inHead?: boolean | Error;
  rebase?: boolean;
  now?: number;
}
function ctx(o: Opts = {}) {
  const notes: Array<[string, string]> = [];
  const order: string[] = [];
  const seams = {
    readJobLog: vi.fn(async () => { if (o.prLog instanceof Error) throw o.prLog; return o.prLog ?? PR_LOG; }),
    readRunHeadSha: vi.fn(async () => PR_HEAD),
    readRunWorkflowId: vi.fn(async () => '4242'),
    listBaseRuns: vi.fn(async () => { if (o.runs instanceof Error) throw o.runs; return o.runs ?? [run('2', 'success', GREEN_SHA), run('1', 'failure')]; }),
    baseRunIds: vi.fn(async (_cwd: string, _c: unknown, runId: string) => (o.ids ?? { '1': [ID, 'x'] })[runId] ?? []),
    commitInHead: vi.fn(async () => { if (o.inHead instanceof Error) throw o.inHead; return o.inHead ?? false; }),
    rebase: vi.fn(async (repo: string) => { order.push(`rebase:${repo}`); return o.rebase ?? true; }),
  };
  const c: BaseRedContext = { store, ticketId: id, key: 'AP-1', seams, now: () => o.now ?? 5_000, note: (t, b) => void notes.push([t, b]), debug: vi.fn() };
  return { c, notes, seams, order };
}

beforeEach(() => { store = openStore(':memory:'); id = createTicket(store, { key: 'AP-1', title: 't' }).id; });

describe('baseRedStep', () => {
  it('(a) rebases once when develop failed the same way and is green now, with the marker written first', async () => {
    const x = ctx();
    x.seams.rebase.mockImplementationOnce(async () => {
      expect(getAutopilotRerun(store, id, 'r', '100', 'Visual')?.pattern).toBe('base-red:develop');
      return true;
    });
    expect(await baseRedStep(x.c, [check()])).toEqual({ kind: 'rebased' });
    expect(x.seams.rebase).toHaveBeenCalledTimes(1);
    expect(x.seams.commitInHead).toHaveBeenCalledWith('/w/r', expect.anything(), GREEN_SHA, PR_HEAD);
    expect(x.notes).toEqual([[
      'Autopilot: rebased on base: Visual failed on develop too (5d7aef5a5) and develop is green at ccccccccc',
      'AP-1: rebased on base: Visual failed on develop too (5d7aef5a5) and develop is green at ccccccccc in r. It used no attempt.',
    ]]);
  });

  it('rebases each repo once when several checks are base red', async () => {
    const x = ctx();
    expect(await baseRedStep(x.c, [check('Visual'), check('Visual 2')])).toEqual({ kind: 'rebased' });
    expect(x.seams.rebase).toHaveBeenCalledTimes(1);
    expect(x.notes).toHaveLength(2);
  });

  it('tags the marker stopped and gives none with the check in earlier when the rebase pushed nothing', async () => {
    const x = ctx({ rebase: false });
    expect(await baseRedStep(x.c, [check()])).toEqual({ kind: 'none', earlier: new Map([['Visual', 'develop']]) });
    expect(baseRedRuns(store, id, 'r', 'Visual')).toEqual([{ runId: '100', base: 'develop', stopped: true, rerunAt: 5_000 }]);
    expect(x.notes[0]![0]).toBe('Autopilot: rebase on base stopped: Visual failed on develop too (5d7aef5a5) and develop is green at ccccccccc');
  });

  it('(b) waits with no rebase while develop is red with the same ids, and writes one event per develop run', async () => {
    const red = { runs: [run('3', 'failure'), run('1', 'failure')], ids: { '3': [ID], '1': [ID] } };
    const first = ctx(red);
    expect(await baseRedStep(first.c, [check()])).toEqual({ kind: 'waiting' });
    expect(first.seams.rebase).not.toHaveBeenCalled();
    expect(first.notes.map((n) => n[0])).toEqual(['Autopilot: waiting for a green develop: Visual fails there too']);
    const second = ctx(red);
    expect(await baseRedStep(second.c, [check()])).toEqual({ kind: 'waiting' });
    expect(second.notes).toEqual([]);
    const newer = ctx({ runs: [run('4', 'failure'), run('1', 'failure')], ids: { '4': [ID], '1': [ID] } });
    expect(await baseRedStep(newer.c, [check()])).toEqual({ kind: 'waiting' });
    expect(newer.notes).toHaveLength(1);
  });

  it('(c) gives none when one failing check is not base red', async () => {
    const x = ctx();
    x.seams.readJobLog.mockImplementation(async (_cwd: string, c: { runId: string }) => (c.runId === '100' ? PR_LOG : ' FAIL  src/own.test.ts > breaks\n'));
    expect(await baseRedStep(x.c, [check('Visual'), check('Unit', 'r', '101')])).toEqual({ kind: 'none', earlier: new Map() });
    expect(x.seams.rebase).not.toHaveBeenCalled();
  });

  it('gives none when a PR id is missing from the develop ids, or no id was extracted', async () => {
    expect((await baseRedStep(ctx({ ids: { '1': ['other'] } }).c, [check()])).kind).toBe('none');
    expect((await baseRedStep(ctx({ prLog: 'npm error\n' }).c, [check()])).kind).toBe('none');
  });

  it('gives none when the newest develop run was cancelled or failed with other ids', async () => {
    expect((await baseRedStep(ctx({ runs: [run('3', 'cancelled'), run('1', 'failure')] }).c, [check()])).kind).toBe('none');
    expect((await baseRedStep(ctx({ runs: [run('3', 'failure'), run('1', 'failure')], ids: { '3': ['other'], '1': [ID] } }).c, [check()])).kind).toBe('none');
  });

  it('gives none when the green develop commit is already in the PR head', async () => {
    const x = ctx({ inHead: true });
    expect((await baseRedStep(x.c, [check()])).kind).toBe('none');
    expect(x.seams.rebase).not.toHaveBeenCalled();
  });

  it('gives none when one develop is green and in the head and another is red', async () => {
    const x = ctx({ inHead: true });
    x.seams.listBaseRuns.mockImplementation(async (_cwd: string, c: { runId: string }) =>
      (c.runId === '100' ? [run('2', 'success', GREEN_SHA), run('1', 'failure')] : [run('5', 'failure'), run('1', 'failure')]));
    x.seams.baseRunIds.mockImplementation(async () => [ID]);
    expect((await baseRedStep(x.c, [check('Visual'), check('Other', 'r', '101')])).kind).toBe('none');
  });

  it('waits and does not rebase when one develop is green and another is still red', async () => {
    const x = ctx();
    x.seams.listBaseRuns.mockImplementation(async (_cwd: string, c: { runId: string }) =>
      (c.runId === '100' ? [run('2', 'success', GREEN_SHA), run('1', 'failure')] : [run('5', 'failure'), run('1', 'failure')]));
    x.seams.baseRunIds.mockImplementation(async () => [ID]);
    expect(await baseRedStep(x.c, [check('Visual'), check('Other', 'r', '101')])).toEqual({ kind: 'waiting' });
    expect(x.seams.rebase).not.toHaveBeenCalled();
  });

  it('(d) gives none with the check in earlier when a marker is on an earlier run', async () => {
    markAutopilotRerun(store, id, { repo: 'r', runId: '99', checkName: 'Visual', headSha: PR_HEAD, pattern: 'base-red:develop', rerunAt: 1 });
    const x = ctx();
    expect(await baseRedStep(x.c, [check()])).toEqual({ kind: 'none', earlier: new Map([['Visual', 'develop']]) });
    expect(x.seams.readJobLog).not.toHaveBeenCalled();
  });

  it('waits on a marker of the current run inside STALE_WAIT_MS, and not after it', async () => {
    markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'Visual', headSha: PR_HEAD, pattern: 'base-red:develop', rerunAt: 1_000 });
    expect(await baseRedStep(ctx({ now: 1_000 + STALE_WAIT_MS - 1 }).c, [check()])).toEqual({ kind: 'rebased' });
    expect(await baseRedStep(ctx({ now: 1_000 + STALE_WAIT_MS }).c, [check()])).toEqual({ kind: 'none', earlier: new Map([['Visual', 'develop']]) });
  });

  it('(e) gives none on any gh error and never reads it as base red', async () => {
    expect((await baseRedStep(ctx({ prLog: new Error('gh') }).c, [check()])).kind).toBe('none');
    expect((await baseRedStep(ctx({ runs: new Error('gh') }).c, [check()])).kind).toBe('none');
    expect((await baseRedStep(ctx({ inHead: new Error('gh') }).c, [check()])).kind).toBe('none');
    const x = ctx();
    x.seams.baseRunIds.mockRejectedValue(new Error('gh'));
    expect((await baseRedStep(x.c, [check()])).kind).toBe('none');
  });

  it('(f) stops waiting for a red develop after 24 hours', async () => {
    const red = { runs: [run('3', 'failure'), run('1', 'failure')], ids: { '3': [ID], '1': [ID] } };
    expect(await baseRedStep(ctx({ ...red, now: 1_000 }).c, [check()])).toEqual({ kind: 'waiting' });
    expect(await baseRedStep(ctx({ ...red, now: 1_000 + BASE_RED_WAIT_MS - 1 }).c, [check()])).toEqual({ kind: 'waiting' });
    const late = ctx({ ...red, now: 1_000 + BASE_RED_WAIT_MS });
    expect(await baseRedStep(late.c, [check()])).toEqual({ kind: 'none', earlier: new Map() });
    expect(late.seams.listBaseRuns).not.toHaveBeenCalled();
  });

  it('gives none for a check without a job url or without a base, and for no failing check', async () => {
    expect((await baseRedStep(ctx().c, [{ ...check(), url: null }])).kind).toBe('none');
    expect((await baseRedStep(ctx().c, [check('Visual', 'r', '100', null)])).kind).toBe('none');
    expect((await baseRedStep(ctx().c, [])).kind).toBe('none');
  });

  it('reads at most MAX_BASE_RED_LOGS failed develop runs and stops at the first proof', async () => {
    const runs = [run('9', 'success', GREEN_SHA), ...['8', '7', '6', '5', '4', '3'].map((r) => run(r, 'failure'))];
    const none = ctx({ runs, ids: {} });
    expect((await baseRedStep(none.c, [check()])).kind).toBe('none');
    expect(none.seams.baseRunIds).toHaveBeenCalledTimes(5);
    const hit = ctx({ runs, ids: { '8': [ID] } });
    expect((await baseRedStep(hit.c, [check()])).kind).toBe('rebased');
    expect(hit.seams.baseRunIds).toHaveBeenCalledTimes(1);
  });
});
