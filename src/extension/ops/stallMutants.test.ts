import { describe, expect, it, vi } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import { openStore } from '../../store/db.js';
import { createTicket, setStageCurrent } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { claimStallSuggestion, saveStallSuggestion } from '../../store/stallSuggestions.js';
import { readTicketDiff } from './stallDiff.js';
import { makeStallActions, stallPlanningKickoff } from './stallActions.js';
import { createStallSuggestionService } from './stallSuggestionService.js';

const AT = '2026-01-01T00:00:00.000Z';
const tree = { repo: '/r', path: '/w', baseRef: 'develop' };
const suggestion = {
  cause: 'Likely a gap.',
  options: [
    { kind: 'agent' as const, label: 'A', note: 'na', recommended: true },
    { kind: 'agent' as const, label: 'B', note: 'nb', recommended: false },
  ],
};

describe('readTicketDiff — exact git calls', () => {
  it('asks git for names and stat with --no-ext-diff and a path separator, and drops blank names', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'merge-base') return { stdout: 'abc\n', stderr: '', exitCode: 0 };
      if (args[1] === '--name-only') return { stdout: ' docs/a.md \n\n', stderr: '', exitCode: 0 };
      return { stdout: '   \n', stderr: '', exitCode: 0 };
    };
    const d = await readTicketDiff(git, [tree]);
    expect(d).toEqual({ files: ['docs/a.md'], stat: '' });
    expect(calls).toContainEqual(['diff', '--name-only', '--no-ext-diff', 'abc', '--']);
    expect(calls).toContainEqual(['diff', '--stat', '--no-ext-diff', 'abc', '--']);
  });
  it('treats a truncated read as unknown, and keeps a stat of exactly the cap whole', async () => {
    const trunc: GitRunner = async (args) => ({ stdout: args[0] === 'merge-base' ? 'abc' : 'x', stderr: '', exitCode: 0, stdoutTruncated: args[1] === '--stat' });
    expect(await readTicketDiff(trunc, [tree])).toBeNull();
    const exact: GitRunner = async (args) => ({ stdout: args[0] === 'merge-base' ? 'abc' : args[1] === '--stat' ? 'y'.repeat(4000) : 'f', stderr: '', exitCode: 0 });
    expect((await readTicketDiff(exact, [tree]))!.stat).toBe('y'.repeat(4000));
  });
  it('joins two stats with a newline and trims their ends', async () => {
    const git: GitRunner = async (args) => ({ stdout: args[0] === 'merge-base' ? 'abc' : args[1] === '--stat' ? 's  \n' : 'f', stderr: '', exitCode: 0 });
    expect((await readTicketDiff(git, [tree, tree]))!.stat).toBe('s\ns');
  });
});

describe('stallPlanningKickoff — exact text', () => {
  it('numbers the options from one, one per line, after the cause', () => {
    const lines = stallPlanningKickoff('ST-1', suggestion).split('\n');
    expect(lines).toContain('Help me decide how to answer the stall. Do not change the ticket yourself.');
    expect(lines).toContain('Likely cause (Karst suggestion): Likely a gap.');
    expect(lines).toContain('Options Karst suggested:');
    expect(lines).toContain('1. A (recommended): na');
    expect(lines).toContain('2. B: nb');
  });
});

function parked(status: 'ready' | 'none') {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'ST-9', title: 't' }).id;
  setStageCurrent(store, ticketId, 'fix');
  setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'stalled', blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: AT });
  if (status === 'ready') { claimStallSuggestion(store, ticketId, AT, AT); saveStallSuggestion(store, ticketId, AT, suggestion, AT); }
  return { store, ticketId };
}

describe('stall planning action — the kickoff source', () => {
  const deps = (store: ReturnType<typeof openStore>, ticketId: number) => ({
    store, ticketId, notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) }, redrive: vi.fn(), refresh: vi.fn(),
    diffFiles: async () => null, maxRounds: () => 5, blockingSeverity: 'medium' as const, ensure: vi.fn(async () => {}), startPlanning: vi.fn(async () => {}),
  });
  it('uses the ticket key and the stored suggestion', async () => {
    const { store, ticketId } = parked('ready');
    const d = deps(store, ticketId);
    await makeStallActions(d).stallPlanning();
    expect(d.startPlanning).toHaveBeenCalledWith('Stalled review ST-9', stallPlanningKickoff('ST-9', suggestion));
  });
  it('says there is no suggestion when the park has no stored answer', async () => {
    const { store, ticketId } = parked('none');
    const d = deps(store, ticketId);
    await makeStallActions(d).stallPlanning();
    expect(d.startPlanning).toHaveBeenCalledWith('Stalled review ST-9', stallPlanningKickoff('ST-9', null));
  });
  it('does not use a suggestion of an earlier park', async () => {
    const { store, ticketId } = parked('ready');
    setStage(store, ticketId, 'fix', { blockedAt: '2026-02-02T00:00:00.000Z' });
    const d = deps(store, ticketId);
    await makeStallActions(d).stallPlanning();
    expect(d.startPlanning).toHaveBeenCalledWith('Stalled review ST-9', stallPlanningKickoff('ST-9', null));
  });
  it('rejects the retry promise when the host refuses', async () => {
    const { store, ticketId } = parked('none');
    const d = deps(store, ticketId);
    d.ensure.mockRejectedValueOnce(new Error('no'));
    await expect(makeStallActions(d).stallRetry()).rejects.toThrow('no');
  });
});

describe('stall suggestion service — guards', () => {
  const run = (setup: (s: ReturnType<typeof openStore>, id: number) => void) => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'S', title: 's' }).id;
    setup(store, ticketId);
    const generate = vi.fn(async () => 'ready' as const);
    const debug = vi.fn();
    const svc = createStallSuggestionService({ store, readDiff: async () => null, generate, refresh: vi.fn(), debug });
    return { svc, ticketId, generate, debug };
  };
  it('does nothing off the fix stage, for another block kind, or for a block without a stamp', async () => {
    for (const setup of [
      (s: ReturnType<typeof openStore>, id: number) => setStage(s, id, 'fix', { blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: AT }),
      (s: ReturnType<typeof openStore>, id: number) => { setStageCurrent(s, id, 'fix'); setStage(s, id, 'fix', { blockedKind: 'boot-failed', blockedReason: 'r', blockedAt: AT }); },
    ]) {
      const r = run(setup);
      await r.svc.ensure(r.ticketId);
      expect(r.generate).not.toHaveBeenCalled();
    }
  });
  it('runs once at a time per park, and logs a thrown generation', async () => {
    const r = run((s, id) => { setStageCurrent(s, id, 'fix'); setStage(s, id, 'fix', { blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: AT }); });
    let release: () => void = () => undefined;
    r.generate.mockImplementationOnce(() => new Promise((res) => { release = () => res('ready'); }));
    const first = r.svc.ensure(r.ticketId);
    await r.svc.ensure(r.ticketId);
    expect(r.generate).toHaveBeenCalledTimes(1);
    release();
    await first;
    r.generate.mockRejectedValueOnce(new Error('boom'));
    await r.svc.ensure(r.ticketId);
    expect(r.debug).toHaveBeenCalledWith(`[stall-suggestion] ticket ${r.ticketId}: boom`);
  });
  it('skips a park that already has an answer, unless Retry', async () => {
    const r = run((s, id) => {
      setStageCurrent(s, id, 'fix'); setStage(s, id, 'fix', { blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: AT });
      claimStallSuggestion(s, id, AT, AT); saveStallSuggestion(s, id, AT, suggestion, AT);
    });
    await r.svc.ensure(r.ticketId);
    expect(r.generate).not.toHaveBeenCalled();
    await r.svc.ensure(r.ticketId, { retry: true });
    expect(r.generate).toHaveBeenCalledTimes(1);
  });
});
