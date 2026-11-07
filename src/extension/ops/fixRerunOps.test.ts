import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import { makeGateRerun, makeRecoverRefusal } from './fixRerunOps.js';
import { NO_NEW_COMMIT_REASON } from '../../workflow/fixRoundGuard.js';

const gate = { gateName: 'unit (web)', repo: 'web', command: 'npm', args: ['run', 'test:unit'], kind: 'command' as const };

describe('makeGateRerun', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    for (const repo of ['web', 'api']) {
      store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(ticketId, repo, `/wt/${repo}`, 'b');
    }
  });
  const rerun = (run: GateProcessRunner) => makeGateRerun({ store, runnerFor: () => run });

  it('runs the gate command in its own repo worktree and maps exit 0', async () => {
    const run = vi.fn<GateProcessRunner>(async () => ({ kind: 'completed', exitCode: 0, output: 'ok' }));
    expect(await rerun(run)(ticketId, gate)).toEqual({ exitCode: 0, summary: null });
    expect(run).toHaveBeenCalledWith('npm', ['run', 'test:unit'], '/wt/web', expect.anything());
  });

  it('summarises the output of a failing gate', async () => {
    const run: GateProcessRunner = async () => ({ kind: 'completed', exitCode: 1, output: 'start\nFAIL boom happened' });
    const res = await rerun(run)(ticketId, gate);
    expect(res.exitCode).toBe(1);
    expect(res.summary).toContain('boom happened');
  });

  it('maps a process that never completed to no exit code with the reason', async () => {
    const spawnFailed: GateProcessRunner = async () => ({ kind: 'spawnFailed', message: 'ENOENT', output: '' });
    expect(await rerun(spawnFailed)(ticketId, gate)).toEqual({ exitCode: null, summary: 'could not start: ENOENT' });
    const timedOut: GateProcessRunner = async () => ({ kind: 'timedOut', output: '' });
    expect((await rerun(timedOut)(ticketId, gate)).summary).toBe('timed out');
  });

  it('refuses a gate whose repo has no worktree', async () => {
    const run = vi.fn<GateProcessRunner>();
    await expect(rerun(run)(ticketId, { ...gate, repo: 'nope' })).rejects.toThrow(/no worktree for repo nope/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('makeGateRerun of a regenerate gate', () => {
  let store: Store;
  let ticketId: number;
  const regen = { gateName: 'regenerate (web)', repo: 'web', command: 'regenerate (web)', args: [] as string[], kind: 'regenerate' as const };
  const spec = { repo: 'web', commands: ['npm run gen', 'npm run docs'] };
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(ticketId, 'web', '/wt/web', 'b');
  });

  it('runs the ship.regenerate commands and never execs the gate label', async () => {
    const run = vi.fn<GateProcessRunner>(async () => ({ kind: 'completed', exitCode: 0, output: '' }));
    const res = await makeGateRerun({ store, runnerFor: () => run, regenerateFor: () => spec })(ticketId, regen);
    expect(res.exitCode).toBe(0);
    expect(run).toHaveBeenCalledWith('sh', ['-c', 'npm run gen'], '/wt/web', expect.anything());
    expect(run).toHaveBeenCalledWith('sh', ['-c', 'npm run docs'], '/wt/web', expect.anything());
    expect(run.mock.calls.map((c) => c[0])).not.toContain('regenerate (web)');
  });

  it('reports a failing generator with its exit code', async () => {
    const run: GateProcessRunner = async (cmd) =>
      cmd === 'sh' ? { kind: 'completed', exitCode: 2, output: 'gen broke' } : { kind: 'completed', exitCode: 0, output: '' };
    const res = await makeGateRerun({ store, runnerFor: () => run, regenerateFor: () => spec })(ticketId, regen);
    expect(res.exitCode).toBe(2);
  });

  it('says the gate cannot be re-run when the manifest declares no ship.regenerate, and execs nothing', async () => {
    const run = vi.fn<GateProcessRunner>();
    const res = await makeGateRerun({ store, runnerFor: () => run, regenerateFor: () => undefined })(ticketId, regen);
    expect(res).toMatchObject({ exitCode: null, cannotRerun: true });
    expect(res.summary).toContain('regenerate (web)');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('makeRecoverRefusal', () => {
  const deps = { store: undefined as unknown as Store, runGate: vi.fn(), debug: vi.fn() };
  it('ignores a refusal that is not the no-new-commit one', async () => {
    const recover = makeRecoverRefusal(1, { ...deps, rerun: vi.fn() });
    expect(await recover('fix', 'cannot mark this stage done: something else')).toBeUndefined();
  });

  it('describes the host re-run outcome for the no-new-commit refusal', async () => {
    const rerun = vi.fn(async () => ({ kind: 'passed' as const, stage: 'uat' as const }));
    const recover = makeRecoverRefusal(7, { ...deps, rerun });
    const res = await recover('fix', `cannot mark this stage done: ${NO_NEW_COMMIT_REASON}`);
    expect(rerun).toHaveBeenCalledWith(7);
    expect(res).toEqual({ ok: true, message: 'no change: failed gates passed on re-run — the ticket returned to uat' });
  });

  it('returns undefined when the host did nothing', async () => {
    const recover = makeRecoverRefusal(7, { ...deps, rerun: async () => ({ kind: 'not-applicable' as const }) });
    expect(await recover('fix', NO_NEW_COMMIT_REASON)).toBeUndefined();
  });
});
