import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { getAutopilotRerun, markAutopilotRerun } from '../../store/autopilot.js';
import type { FailedCheck } from './autopilotRerun.js';
import { staleRebaseStep, type StaleRebaseContext } from './autopilotStaleRebase.js';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const CMD = 'npm run -s docs:graph';
const STALE = `docs/arch/system-map.md is stale: run ${CMD}\n##[error]Process completed with exit code 1.\n`;
let store: Store;
let id: number;

const check = (name: string, repo = 'r', run = '100', job = '200'): FailedCheck => ({
  repo, cwd: `/w/${repo}`, name, url: `https://github.com/o/${repo}/actions/runs/${run}/job/${job}`,
});

function ctx(o: { log?: string | Error; sha?: string | Error; rebase?: boolean | Error; regenerate?: readonly string[] } = {}) {
  const notes: Array<[string, string]> = [];
  const debug = vi.fn();
  const order: string[] = [];
  const readJobLog = vi.fn(async () => { if (o.log instanceof Error) throw o.log; return o.log ?? STALE; });
  const readRunHeadSha = vi.fn(async (_cwd: string, _c?: unknown) => { if (o.sha instanceof Error) throw o.sha; return o.sha ?? SHA; });
  const rebase = vi.fn(async (repo: string) => {
    order.push(`rebase:${repo}`);
    if (o.rebase instanceof Error) throw o.rebase;
    return o.rebase ?? true;
  });
  const c: StaleRebaseContext = {
    store, ticketId: id, key: 'AP-1', now: () => 5_000, note: (t, b) => void notes.push([t, b]), debug,
    seams: { readJobLog, readRunHeadSha, regenerate: () => o.regenerate ?? [CMD], rebase },
  };
  return { c, notes, debug, readJobLog, readRunHeadSha, rebase, order };
}

beforeEach(() => { store = openStore(':memory:'); id = createTicket(store, { key: 'AP-1', title: 't' }).id; });

describe('staleRebaseStep', () => {
  it('rebases once, writes the marker first, and writes one note and one debug line', async () => {
    const x = ctx();
    expect(await staleRebaseStep(x.c, [check('A')])).toEqual({ kind: 'rebased' });
    expect(x.rebase).toHaveBeenCalledTimes(1);
    expect(x.rebase).toHaveBeenCalledWith('r');
    expect(getAutopilotRerun(store, id, 'r', '100', 'A')).toEqual({
      repo: 'r', runId: '100', checkName: 'A', headSha: SHA, pattern: `stale-generated:${CMD}`, rerunAt: 5_000,
    });
    expect(x.notes).toEqual([[
      `Autopilot: rebased on base for ${CMD} after A failed on abcdef012`,
      `AP-1: rebased on base for ${CMD} after A failed on abcdef012 in r. It used no attempt.`,
    ]]);
    expect(x.debug).toHaveBeenCalledWith(`[ship] autopilot ticket AP-1 ci: rebased on base for ${CMD} after A failed on abcdef012`);
  });

  it('has the marker in the store when the rebase runs', async () => {
    const x = ctx();
    x.rebase.mockImplementationOnce(async () => {
      expect(getAutopilotRerun(store, id, 'r', '100', 'A')).not.toBeNull();
      return true;
    });
    await staleRebaseStep(x.c, [check('A')]);
    expect(x.rebase).toHaveBeenCalledTimes(1);
  });

  it('returns none with no read and no rebase when there is no failing check', async () => {
    const x = ctx();
    expect(await staleRebaseStep(x.c, [])).toEqual({ kind: 'none', earlier: new Set() });
    expect(x.readJobLog).not.toHaveBeenCalled();
  });

  it('names the earlier checks and does not rebase again', async () => {
    const x = ctx();
    markAutopilotRerun(store, id, { repo: 'r', runId: '99', checkName: 'A', headSha: SHA, pattern: `stale-generated:${CMD}`, rerunAt: 1 });
    expect(await staleRebaseStep(x.c, [check('A'), check('B', 'r', '100', '201')])).toEqual({ kind: 'none', earlier: new Set(['A']) });
    expect(x.readJobLog).not.toHaveBeenCalled();
    expect(x.rebase).not.toHaveBeenCalled();
  });

  it('does not count a network re-run marker as a rebase', async () => {
    const x = ctx();
    markAutopilotRerun(store, id, { repo: 'r', runId: '99', checkName: 'A', headSha: SHA, pattern: 'econnreset', rerunAt: 1 });
    expect(await staleRebaseStep(x.c, [check('A')])).toEqual({ kind: 'rebased' });
  });

  it('returns none when a check has no job url', async () => {
    const x = ctx();
    expect(await staleRebaseStep(x.c, [{ repo: 'r', cwd: '/w/r', name: 'A', url: null }])).toEqual({ kind: 'none', earlier: new Set() });
    expect(x.rebase).not.toHaveBeenCalled();
  });

  it('returns none and writes no marker when the log cannot be read', async () => {
    const x = ctx({ log: new Error('gh down') });
    expect(await staleRebaseStep(x.c, [check('A')])).toEqual({ kind: 'none', earlier: new Set() });
    expect(x.rebase).not.toHaveBeenCalled();
    expect(getAutopilotRerun(store, id, 'r', '100', 'A')).toBeNull();
  });

  it('returns none when the log has another error line', async () => {
    const x = ctx({ log: `${STALE}##[error]Something else\n` });
    expect(await staleRebaseStep(x.c, [check('A')])).toEqual({ kind: 'none', earlier: new Set() });
    expect(x.rebase).not.toHaveBeenCalled();
  });

  it('passes the log path of each check and the repo command list to the classifier', async () => {
    const x = ctx({ regenerate: [] });
    expect(await staleRebaseStep(x.c, [check('A')])).toEqual({ kind: 'none', earlier: new Set() });
    expect(x.readJobLog).toHaveBeenCalledWith('/w/r', { owner: 'o', repo: 'r', runId: '100', jobId: '200' });
  });

  it('returns none and writes no marker when the run head sha cannot be read', async () => {
    const x = ctx({ sha: new Error('gh down') });
    expect(await staleRebaseStep(x.c, [check('A')])).toEqual({ kind: 'none', earlier: new Set() });
    expect(x.rebase).not.toHaveBeenCalled();
    expect(getAutopilotRerun(store, id, 'r', '100', 'A')).toBeNull();
  });

  it('keeps the ticket waiting when a later repo head sha read fails after an earlier repo pushed', async () => {
    const x = ctx();
    x.readRunHeadSha.mockImplementation(async (cwd: string) => { if (cwd === '/w/r2') throw new Error('gh down'); return SHA; });
    expect(await staleRebaseStep(x.c, [check('A', 'r1'), check('B', 'r2')])).toEqual({ kind: 'rebased' });
    expect(x.order).toEqual(['rebase:r1']);
    expect(getAutopilotRerun(store, id, 'r2', '100', 'B')).toBeNull();
  });

  it('writes the stopped note and returns none naming the check when the rebase stops', async () => {
    const x = ctx({ rebase: false });
    expect(await staleRebaseStep(x.c, [check('A')])).toEqual({ kind: 'none', earlier: new Set(['A']) });
    expect(x.notes).toEqual([[
      `Autopilot: rebase on base stopped for ${CMD} after A failed on abcdef012`,
      `AP-1: rebase on base stopped for ${CMD} after A failed on abcdef012 in r. It used no attempt. Today's rules apply.`,
    ]]);
    expect(x.debug).toHaveBeenCalledWith(`[ship] autopilot ticket AP-1 ci: rebase on base stopped for ${CMD} after A failed on abcdef012`);
  });

  it('treats a rebase that throws as stopped', async () => {
    const x = ctx({ rebase: new Error('boom') });
    expect(await staleRebaseStep(x.c, [check('A')])).toEqual({ kind: 'none', earlier: new Set(['A']) });
    expect(x.notes[0]![0]).toContain('stopped');
  });

  it('rebases one repo once for several checks and writes a marker and a note for each', async () => {
    const x = ctx();
    expect(await staleRebaseStep(x.c, [check('A'), check('B', 'r', '100', '201')])).toEqual({ kind: 'rebased' });
    expect(x.rebase).toHaveBeenCalledTimes(1);
    expect(x.readRunHeadSha).toHaveBeenCalledTimes(1);
    expect(getAutopilotRerun(store, id, 'r', '100', 'B')).not.toBeNull();
    expect(x.notes).toHaveLength(2);
  });

  it('rebases each repo once', async () => {
    const x = ctx();
    expect(await staleRebaseStep(x.c, [check('A', 'r1'), check('B', 'r2')])).toEqual({ kind: 'rebased' });
    expect(x.order).toEqual(['rebase:r1', 'rebase:r2']);
  });

  it('returns rebased when one repo pushed and another stopped, and names no check as earlier', async () => {
    const x = ctx();
    x.rebase.mockImplementation(async (repo: string) => repo === 'r1');
    expect(await staleRebaseStep(x.c, [check('A', 'r1'), check('B', 'r2')])).toEqual({ kind: 'rebased' });
    expect(x.notes.map((n) => n[0])).toEqual([
      `Autopilot: rebased on base for ${CMD} after A failed on abcdef012`,
      `Autopilot: rebase on base stopped for ${CMD} after B failed on abcdef012`,
    ]);
  });

  it('returns none and does not rebase when a network marker already exists for the same run and check', async () => {
    const x = ctx();
    markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'A', headSha: SHA, pattern: 'econnreset', rerunAt: 1 });
    expect(await staleRebaseStep(x.c, [check('A')])).toEqual({ kind: 'none', earlier: new Set() });
    expect(x.rebase).not.toHaveBeenCalled();
    expect(x.notes).toEqual([]);
  });

  it('joins the commands of one log in the marker pattern', async () => {
    const x = ctx({
      log: `a.md is stale: run ${CMD}\nb.md is stale: run npm run -s docs:index\n`,
      regenerate: [CMD, 'npm run -s docs:index'],
    });
    await staleRebaseStep(x.c, [check('A')]);
    expect(getAutopilotRerun(store, id, 'r', '100', 'A')!.pattern).toBe(`stale-generated:${CMD}; npm run -s docs:index`);
  });
});
