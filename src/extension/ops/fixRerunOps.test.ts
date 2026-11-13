import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import type { ResolvedGate } from '../../workflow/gates/resolve.js';
import { leaseGateSlot } from '../../workflow/gates/gateLease.js';
import { listGateRuns, HOST_RERUN_SOURCE } from '../../store/gateRuns.js';
import { makeGateRerun, makeManifestGatesFor, makeRecoverRefusal, makeRequestedRerunSweep } from './fixRerunOps.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { addHostGates } from '../../store/ticketGates.js';
import { setStage } from '../../store/stages.js';
import { NO_NEW_COMMIT_REASON } from '../../workflow/fixRoundGuard.js';
import { uat } from '../../manifest/fixtures.js';
import type { FailedGate } from '../../workflow/fixHostRerun.js';

const failed = (over: Partial<FailedGate> = {}): FailedGate => ({
  gateName: 'unit (web)', repo: 'web', command: 'npm', args: ['run', 'test:unit'], kind: 'command', ...over,
});
const resolved = (over: Partial<ResolvedGate> = {}): ResolvedGate => ({
  name: 'unit', command: 'npm', args: ['run', 'test:unit'], script: null, required: false, ...over,
});
const ok = (output = 'ok'): Awaited<ReturnType<GateProcessRunner>> => ({ kind: 'completed', exitCode: 0, output });

describe('makeGateRerun through runGateList', () => {
  let store: Store;
  let ticketId: number;
  let slots: string;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    slots = mkdtempSync(join(tmpdir(), 'karst-rerun-slots-'));
    for (const repo of ['web', 'api']) {
      store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(ticketId, repo, `/wt/${repo}`, 'b');
    }
  });
  const make = (run: GateProcessRunner, over: Partial<Parameters<typeof makeGateRerun>[0]> = {}) =>
    makeGateRerun({ store, runnerFor: () => run, gatesFor: () => [resolved()], gateSlotsDir: slots, ...over });

  it('runs the gate in its repo worktree and maps exit 0', async () => {
    const run = vi.fn<GateProcessRunner>(async () => ok());
    expect(await make(run)(ticketId, [failed()], 'uat')).toEqual([{ exitCode: 0, summary: null }]);
    expect(run.mock.calls[0]?.[2]).toBe('/wt/web');
  });

  it('summarises the output of a failing gate', async () => {
    const run: GateProcessRunner = async () => ({ kind: 'completed', exitCode: 1, output: 'start\nFAIL boom happened' });
    const [res] = await make(run)(ticketId, [failed()], 'uat');
    expect(res?.exitCode).toBe(1);
    expect(res?.summary).toContain('boom happened');
  });

  it('maps a process that never completed to no exit code with the reason', async () => {
    const spawnFailed: GateProcessRunner = async () => ({ kind: 'spawnFailed', message: 'ENOENT', output: '' });
    const [a] = await make(spawnFailed, { gatesFor: () => [resolved({ required: true })] })(ticketId, [failed()], 'uat');
    expect(a?.exitCode).not.toBe(0);
  });

  it('makes one runGateList call per repo worktree with that repo gates only, at the same time', async () => {
    const calls: { gates: string[]; cwd: string }[] = [];
    const runGates = vi.fn(async (gates: readonly ResolvedGate[], cwd: string) => {
      calls.push({ gates: gates.map((g) => g.name), cwd });
      return { kind: 'ran' as const, results: [] };
    });
    const gatesFor = (_t: number, repo: string): ResolvedGate[] =>
      repo === 'web' ? [resolved({ name: 'unit' }), resolved({ name: 'lint', args: ['run', 'lint'] })] : [resolved({ name: 'e2e', args: ['run', 'e2e'] })];
    const res = await make(vi.fn(), { runGates, gatesFor })(
      ticketId,
      [failed(), failed({ gateName: 'lint (web)', args: ['run', 'lint'] }), failed({ gateName: 'e2e (api)', repo: 'api', args: ['run', 'e2e'] })],
      'uat',
    );
    expect(runGates).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(expect.arrayContaining([
      { gates: ['unit', 'lint'], cwd: '/wt/web' },
      { gates: ['e2e'], cwd: '/wt/api' },
    ]));
    expect(res).toHaveLength(3);
  });

  it('runs a failed regenerate row as opts.regenerate and does not run a passed one', async () => {
    const seen: (unknown)[] = [];
    const runGates = vi.fn(async (_g: readonly ResolvedGate[], _c: string, opts?: { regenerate?: unknown }) => {
      seen.push(opts?.regenerate);
      return { kind: 'ran' as const, results: [] };
    });
    const spec = { repo: 'web', commands: ['npm run gen'] };
    const regen = failed({ gateName: 'regenerate (web)', command: 'regenerate (web)', args: [], kind: 'regenerate' });
    await make(vi.fn(), { runGates, regenerateFor: () => spec })(ticketId, [regen, failed()], 'uat');
    await make(vi.fn(), { runGates, regenerateFor: () => spec })(ticketId, [failed()], 'uat');
    expect(seen).toEqual([spec, undefined]);
  });

  it('says a regenerate row cannot be re-run when the manifest declares no commands', async () => {
    const runGates = vi.fn(async () => ({ kind: 'ran' as const, results: [] }));
    const regen = failed({ gateName: 'regenerate (web)', command: 'regenerate (web)', args: [], kind: 'regenerate' });
    const [res] = await make(vi.fn(), { runGates, regenerateFor: () => undefined, gatesFor: () => [] })(ticketId, [regen], 'uat');
    expect(res).toMatchObject({ exitCode: null, cannotRerun: true });
    expect(res?.summary).toContain('regenerate (web)');
  });

  it('keeps cannotRerun for a gate the manifest no longer declares', async () => {
    const run = vi.fn<GateProcessRunner>();
    const [res] = await make(run, { gatesFor: () => [resolved({ args: ['run', 'other'] })] })(ticketId, [failed()], 'uat');
    expect(res).toMatchObject({ exitCode: null, cannotRerun: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('fails a gate whose repo has no worktree without running anything', async () => {
    const run = vi.fn<GateProcessRunner>();
    const [res] = await make(run)(ticketId, [failed({ repo: 'nope' })], 'uat');
    expect(res).toEqual({ exitCode: null, summary: 're-run error: no worktree for repo nope' });
    expect(run).not.toHaveBeenCalled();
  });

  it('gives a UI gate the 45 minute timeout and the lease, base ref and port env', async () => {
    const run = vi.fn<GateProcessRunner>(async () => ok());
    const ui = resolved({ name: 'visual', script: 'test:visual:docker', args: ['run', 'test:visual:docker'], maxConcurrent: 1 });
    await make(run, { gatesFor: () => [ui], baseRefFor: () => 'origin/develop' })(ticketId, [failed({ gateName: 'visual (web)', args: ['run', 'test:visual:docker'] })], 'uat');
    const [cmd, args, , opts] = run.mock.calls[0]!;
    expect(cmd).toBe('env');
    expect(args).toEqual(expect.arrayContaining(['KARST_GATE_LEASE_HELD=1', 'KARST_BASE_REF=origin/develop']));
    expect(opts?.timeoutMs).toBe(45 * 60 * 1000);
  });

  it('waits for a held visual slot before the spawn', async () => {
    const run = vi.fn<GateProcessRunner>(async () => ok());
    const held = await leaseGateSlot('visual', 1, { dir: slots });
    const ui = resolved({ name: 'visual', script: 'test:visual:docker', args: ['run', 'test:visual:docker'], maxConcurrent: 1 });
    const p = make(run, { gatesFor: () => [ui], gateSlotPollMs: 10 })(ticketId, [failed({ gateName: 'visual (web)', args: ['run', 'test:visual:docker'] })], 'uat');
    await new Promise((r) => setTimeout(r, 80));
    expect(run).not.toHaveBeenCalled();
    await held.release();
    await p;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs a sandbox: host gate of a sandboxed ticket on the host runner', async () => {
    const sandbox = vi.fn<GateProcessRunner>(async () => ok());
    const host = vi.fn<GateProcessRunner>(async () => ok());
    const g = resolved({ name: 'visual', sandbox: 'host' });
    await make(sandbox, { gatesFor: () => [g], hostGateFor: () => host, sandboxedFor: () => true })(ticketId, [failed()], 'uat');
    expect(host).toHaveBeenCalledTimes(1);
    expect(sandbox).not.toHaveBeenCalled();
  });

  it('streams output and the pid to the host callbacks, bound to the ticket and stage', async () => {
    const onGateOutput = vi.fn();
    const onGateSpawned = vi.fn();
    const run: GateProcessRunner = async (_c, _a, _w, o) => {
      o?.onOutput?.({ stream: 'stdout', text: 'hi' });
      o?.onSpawned?.(42);
      return ok();
    };
    await make(run, { onGateOutput, onGateSpawned })(ticketId, [failed()], 'uat');
    expect(onGateOutput).toHaveBeenCalledWith(ticketId, 'uat', 'unit', { stream: 'stdout', text: 'hi' });
    expect(onGateSpawned).toHaveBeenCalledWith(ticketId, 'unit', 42, '/wt/web');
  });

  it('writes marked gate_runs rows that the default list skips', async () => {
    const run = vi.fn<GateProcessRunner>(async () => ok());
    await make(run)(ticketId, [failed()], 'uat');
    expect(listGateRuns(store, ticketId)).toEqual([]);
    const rows = listGateRuns(store, ticketId, { includeHostRerun: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: HOST_RERUN_SOURCE, stageKey: 'uat' });
    expect(JSON.stringify(rows[0])).toContain('unit (web)');
  });

  it('writes each gate row when the gate completes, so a later throw keeps the earlier rows', async () => {
    const runGates = vi.fn(async (_g: readonly ResolvedGate[], _cwd: string, opts: { onGateComplete?: (...a: never[]) => void }) => {
      (opts.onGateComplete as (n: string, e: number, s: string, t: string, i: number, o: string) => void)('unit', 1, 'a', 'b', 0, 'boom');
      throw new Error('crash');
    });
    const res = await make(vi.fn(), { runGates: runGates as never })(ticketId, [failed()], 'uat');
    expect(res[0]?.summary).toMatch(/re-run error: crash/);
    expect(listGateRuns(store, ticketId, { includeHostRerun: true })).toHaveLength(1);
  });

  it('gives every failed row of one manifest gate the result of that gate', async () => {
    const run = vi.fn<GateProcessRunner>(async () => ok());
    const res = await make(run)(ticketId, [failed(), failed({ gateName: 'unit again (web)' })], 'uat');
    expect(res).toEqual([{ exitCode: 0, summary: null }, { exitCode: 0, summary: null }]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('asks the resolver for the stage of the failed round', async () => {
    const gatesFor = vi.fn(() => [resolved()]);
    await make(vi.fn<GateProcessRunner>(async () => ok()), { gatesFor })(ticketId, [failed()], 'review');
    expect(gatesFor).toHaveBeenCalledWith(ticketId, 'web', '/wt/web', 'review');
  });
});

describe('makeRecoverRefusal', () => {
  const deps = { store: undefined as unknown as Store, debug: vi.fn() };
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

describe('makeRequestedRerunSweep', () => {
  it('runs a requested re-run once and reports a failed sweep without throwing', async () => {
    const store = openStore(':memory:');
    const { upsertProject } = await import('../../store/projects.js');
    const { requestHostRerun } = await import('../../workflow/fixHostRerunRequest.js');
    const { openRecoveryRound } = await import('../../store/recoveryRounds.js');
    const { recordGateRun } = await import('../../store/gateRuns.js');
    const project = upsertProject(store, { slug: 'p' });
    const ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId: project.id }).id;
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(ticketId, 'web', '/wt/web', 'b');
    recordGateRun(store, { ticketId, stageKey: 'uat', attempt: 1, runAt: '2026-01-01T00:00:00Z', gates: [{ gateName: 'unit (web)', exitCode: 1, repo: 'web', command: 'npm', args: ['t'], summary: 's' }] });
    const round = openRecoveryRound(store, { ticketId, sourceStage: 'uat', sourceProcessId: 'gates', triggerKind: 'gate-failure', triggerDetail: 'x', maxRounds: 3, startedAt: '2026-01-01T00:00:00Z' } as never);
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(round.id);
    requestHostRerun(store, ticketId, '2026-01-01T00:00:00Z');
    const run = vi.fn<GateProcessRunner>(async () => ({ kind: 'completed', exitCode: 0, output: 'ok' }));
    const debug = vi.fn();
    const sweep = makeRequestedRerunSweep({ store, runnerFor: () => run, gatesFor: () => [resolved({ args: ['t'] })], gateSlotsDir: mkdtempSync(join(tmpdir(), 'karst-rerun-slots-')), projectId: () => project.id, debug });
    await sweep();
    await sweep();
    expect(run).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('[fix-rerun] requested by the host CLI: passed');
    expect(store.db.prepare('SELECT status FROM recovery_rounds WHERE id = ?').get(round.id)).toEqual({ status: 'passed' });
  });

  it('does nothing without a project', async () => {
    const run = vi.fn<GateProcessRunner>();
    await makeRequestedRerunSweep({ store: openStore(':memory:'), runnerFor: () => run, projectId: () => undefined })();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('makeManifestGatesFor', () => {
  const probing = () => uat({ probeWhenAllDisabled: true });
  const worktree = (scripts: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-rerun-wt-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
    return dir;
  };

  it('resolves the gates of the worktree as UAT does, by the manifest names of the repo', () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    const seen: string[][] = [];
    const gatesFor = makeManifestGatesFor({ store, uat: probing, namesFor: (repo) => (seen.push([repo]), ['web']) });
    const gates = gatesFor(id, '/repo/web', worktree({ test: 'vitest' }), 'uat');
    expect(seen).toEqual([['/repo/web']]);
    expect(gates?.map((g) => g.name)).toEqual(['test']);
  });

  it('applies the ticket host override to the resolved gates', () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    const wt = worktree({ test: 'vitest' });
    const base = makeManifestGatesFor({ store, uat: probing })(id, 'web', wt, 'uat')!;
    const name = base.find((g) => g.name === 'test')!.name;
    addHostGates(store, id, [name]);
    const over = makeManifestGatesFor({ store, uat: probing })(id, 'web', wt, 'uat')!;
    expect(over.find((g) => g.name === name)?.onResourceKill).toBe('host');
  });

  it('resolves a review-stage round from the review config, not from the uat config', () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    const wt = worktree({ test: 'vitest', lint: 'eslint' });
    const review = { gates: [{ name: 'lint', command: 'npm', args: ['run', 'lint'] }], repositories: {} } as never;
    const gatesFor = makeManifestGatesFor({ store, uat: probing, review: () => review });
    expect(gatesFor(id, 'web', wt, 'review')?.map((g) => g.name)).toEqual(['lint']);
    expect(gatesFor(id, 'web', wt, 'uat')?.map((g) => g.name)).toEqual(['test']);
  });

  it('answers undefined when the worktree has no package.json to resolve from', () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    expect(makeManifestGatesFor({ store, uat: probing })(id, 'web', mkdtempSync(join(tmpdir(), 'karst-rerun-empty-')), 'uat')).toBeUndefined();
  });
});

type Complete = (name: string, exit: number | null, s: string | null, e: string | null, index: number, out?: string) => void;
type Opts = Record<string, unknown> & { onGateComplete: Complete; onGateStart: (n: string) => void; onGateOutput: (n: string, c: unknown) => void; onGateSpawned: (n: string, p: number, c: string) => void };

describe('makeGateRerun exact options, rows and results', () => {
  let store: Store;
  let ticketId: number;
  const AT = '2026-01-01T00:00:00Z';
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    for (const repo of ['web', 'api']) {
      store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(ticketId, repo, `/wt/${repo}`, 'b');
    }
  });
  const regenGate = (over: Partial<FailedGate> = {}): FailedGate => failed({ gateName: 'regenerate (web)', command: 'regenerate (web)', args: [], kind: 'regenerate', ...over });
  const spy = (script: (opts: Opts, cwd: string) => void | Promise<void>, kind: 'ran' | 'stopped' = 'ran') => {
    const calls: { gates: readonly ResolvedGate[]; cwd: string; opts: Opts }[] = [];
    const runGates = vi.fn(async (gates: readonly ResolvedGate[], cwd: string, opts: Opts) => {
      calls.push({ gates, cwd, opts });
      await script(opts, cwd);
      return { kind, results: [] };
    });
    return { calls, runGates: runGates as never };
  };
  const base = { runnerFor: (): GateProcessRunner => vi.fn() as never, gatesFor: () => [resolved()] };
  const rerun = (over: Partial<Parameters<typeof makeGateRerun>[0]>) => makeGateRerun({ store, ...base, ...over });
  const rows = () => listGateRuns(store, ticketId, { includeHostRerun: true });

  it('passes only the options it was given, so a bare dependency set adds none', async () => {
    const s = spy(() => undefined);
    await rerun({ runGates: s.runGates })(ticketId, [failed()], 'uat');
    expect(Object.keys(s.calls[0]!.opts).sort()).toEqual(['now', 'onGateComplete', 'onGateOutput', 'onGateSpawned', 'onGateStart', 'prBody', 'runProcess', 'sandboxed']);
    expect(s.calls[0]!.opts.sandboxed).toBe(false);
    expect(typeof s.calls[0]!.opts.prBody).toBe('string');
  });

  it('passes every option a full dependency set gives, and the host gate runner wins over the host runner', async () => {
    const s = spy(() => undefined);
    const runner = vi.fn() as never;
    const hostRunner = vi.fn() as never;
    const hostGate = vi.fn() as never;
    const debug = vi.fn();
    const deps = { runGates: s.runGates, runnerFor: () => runner, hostRunner, baseRefFor: () => 'origin/develop', sandboxedFor: () => true, gateSlotsDir: '/slots', gateSlotPollMs: 0, debug };
    await rerun(deps)(ticketId, [failed()], 'uat');
    await rerun({ ...deps, hostGateFor: () => hostGate })(ticketId, [failed()], 'uat');
    const [a, b] = s.calls.map((c) => c.opts);
    expect(a).toMatchObject({ baseRef: 'origin/develop', runProcess: runner, hostProcess: hostRunner, sandboxed: true, gateSlotsDir: '/slots', gateSlotPollMs: 0, onDebug: debug });
    expect(b!.hostProcess).toBe(hostGate);
  });

  it('gives the base ref of the repo of the group, and no base ref when it has none', async () => {
    const s = spy(() => undefined);
    const baseRefFor = vi.fn((_t: number, repo: string) => (repo === 'api' ? undefined : 'origin/web'));
    await rerun({ runGates: s.runGates, baseRefFor })(ticketId, [failed(), failed({ repo: 'api', gateName: 'unit (api)' })], 'uat');
    expect(baseRefFor).toHaveBeenCalledWith(ticketId, 'web');
    expect(baseRefFor).toHaveBeenCalledWith(ticketId, 'api');
    const byCwd = Object.fromEntries(s.calls.map((c) => [c.cwd, c.opts]));
    expect(byCwd['/wt/web']).toMatchObject({ baseRef: 'origin/web' });
    expect('baseRef' in byCwd['/wt/api']!).toBe(false);
  });

  it('binds the stage and the ticket to the start, output and pid callbacks', async () => {
    const onGateStart = vi.fn();
    const onGateOutput = vi.fn();
    const onGateSpawned = vi.fn();
    const s = spy((o) => {
      o.onGateStart('unit');
      o.onGateOutput('unit', { stream: 'stderr', text: 'x' });
      o.onGateSpawned('unit', 7, '/wt/web');
    });
    await rerun({ runGates: s.runGates, onGateStart, onGateOutput, onGateSpawned })(ticketId, [failed()], 'review');
    expect(onGateStart).toHaveBeenCalledWith(ticketId, 'review', 'unit');
    expect(onGateOutput).toHaveBeenCalledWith(ticketId, 'review', 'unit', { stream: 'stderr', text: 'x' });
    expect(onGateSpawned).toHaveBeenCalledWith(ticketId, 'unit', 7, '/wt/web');
  });

  it('does not throw when the host gives no callbacks', async () => {
    const s = spy((o) => {
      o.onGateStart('unit');
      o.onGateOutput('unit', {});
      o.onGateSpawned('unit', 1, '/wt/web');
    });
    await expect(rerun({ runGates: s.runGates })(ticketId, [failed()], 'uat')).resolves.toHaveLength(1);
  });

  it('writes a row with the run time, the attempt, the identity and the failure summary', async () => {
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'x', startedAt: AT, endedAt: AT, attempt: 3 });
    const s = spy((o) => o.onGateComplete('unit', 1, 'a', 'b', 0, 'start\nFAIL boom happened'));
    const res = await rerun({ runGates: s.runGates, now: () => '2026-02-02T00:00:00Z' })(ticketId, [failed()], 'uat');
    expect(rows()).toEqual([
      expect.objectContaining({
        gateName: 'unit (web)', exitCode: 1, startedAt: 'a', endedAt: 'b', repo: 'web', command: 'npm', args: ['run', 'test:unit'],
        attempt: 3, runAt: '2026-02-02T00:00:00Z', stageKey: 'uat', source: HOST_RERUN_SOURCE,
      }),
    ]);
    expect(rows()[0]!.summary).toContain('boom happened');
    expect(res[0]).toEqual({ exitCode: 1, summary: rows()[0]!.summary });
  });

  it('writes no summary and no null times for a passed gate that has none', async () => {
    const s = spy((o) => o.onGateComplete('unit', 0, null, null, 0, undefined));
    const res = await rerun({ runGates: s.runGates })(ticketId, [failed()], 'uat');
    expect(rows()[0]).toMatchObject({ exitCode: 0, summary: null, startedAt: null, endedAt: null });
    expect(res).toEqual([{ exitCode: 0, summary: null }]);
  });

  it('names a row after the gate when no failed row maps to it', async () => {
    const s = spy((o) => o.onGateComplete('ghost', 0, 'a', 'b', 5, ''));
    await rerun({ runGates: s.runGates })(ticketId, [failed()], 'uat');
    expect(rows()[0]).toMatchObject({ gateName: 'ghost', command: 'ghost', args: [], repo: 'web' });
  });

  it('answers a gate that could not run with its output, or with the default reason', async () => {
    const s = spy((o) => {
      o.onGateComplete('unit', null, 'a', 'b', 0, 'ENOENT npm');
      o.onGateComplete('lint', null, 'a', 'b', 1, '');
    });
    const gatesFor = () => [resolved(), resolved({ name: 'lint', args: ['run', 'lint'] })];
    const res = await rerun({ runGates: s.runGates, gatesFor })(ticketId, [failed(), failed({ gateName: 'lint (web)', args: ['run', 'lint'] })], 'uat');
    expect(res).toEqual([{ exitCode: null, summary: 'ENOENT npm' }, { exitCode: null, summary: 'the gate could not run' }]);
  });

  it('takes the regenerate result from the row of index -1 and says the gates did not run when it failed', async () => {
    const spec = { repo: 'web', commands: ['npm run gen'] };
    const s = spy((o) => o.onGateComplete('regenerate (web)', 1, 'a', 'b', -1, 'FAIL gen broke'));
    const res = await rerun({ runGates: s.runGates, regenerateFor: () => spec })(ticketId, [regenGate(), failed()], 'uat');
    expect(res[0]).toMatchObject({ exitCode: 1 });
    expect(res[0]!.summary).toContain('gen broke');
    expect(res[1]).toEqual({ exitCode: null, summary: 'not run: regenerate failed' });
    expect(rows()[0]).toMatchObject({ gateName: 'regenerate (web)', command: 'regenerate (web)', args: [] });
  });

  it('passes a regenerate row that passed, and still runs the gate', async () => {
    const spec = { repo: 'web', commands: ['npm run gen'] };
    const s = spy((o) => {
      o.onGateComplete('regenerate (web)', 0, 'a', 'b', -1, 'ok');
      o.onGateComplete('unit', 0, 'a', 'b', 0, 'ok');
    });
    const res = await rerun({ runGates: s.runGates, regenerateFor: () => spec })(ticketId, [regenGate(), failed()], 'uat');
    expect(res).toEqual([{ exitCode: 0, summary: null }, { exitCode: 0, summary: null }]);
  });

  it('writes no regenerate result when a regenerate completion comes with no regenerate row', async () => {
    const s = spy((o) => o.onGateComplete('regenerate (web)', 0, 'a', 'b', -1, 'ok'));
    const res = await rerun({ runGates: s.runGates })(ticketId, [failed()], 'uat');
    expect(res).toEqual([{ exitCode: null, summary: 'not run: regenerate failed' }]);
  });

  it('reports a stopped run as aborted', async () => {
    const s = spy(() => undefined, 'stopped');
    const res = await rerun({ runGates: s.runGates })(ticketId, [failed()], 'uat');
    expect(res).toEqual([{ exitCode: null, summary: 'aborted' }]);
  });

  it('looks the regenerate spec up by the repo in the gate name, or by the group repo for another name', async () => {
    const regenerateFor = vi.fn(() => undefined);
    const s = spy(() => undefined);
    await rerun({ runGates: s.runGates, regenerateFor })(ticketId, [regenGate({ gateName: 'regenerate (alias)' })], 'uat');
    await rerun({ runGates: s.runGates, regenerateFor })(ticketId, [regenGate({ gateName: 'regen' })], 'uat');
    expect(regenerateFor.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['alias', 'web']);
  });

  it('says the regenerate row cannot be re-run, with the name, when the spec has no commands', async () => {
    const s = spy(() => undefined);
    const empty = { repo: 'web', commands: [] };
    const none = await rerun({ runGates: s.runGates, regenerateFor: () => undefined })(ticketId, [regenGate()], 'uat');
    const noCmd = await rerun({ runGates: s.runGates, regenerateFor: () => empty })(ticketId, [regenGate()], 'uat');
    const want = { exitCode: null, cannotRerun: true, summary: 'regenerate (web) has no ship.regenerate commands in the manifest' };
    expect(none).toEqual([want]);
    expect(noCmd).toEqual([want]);
    expect(s.calls).toHaveLength(0);
  });

  it('still runs the regenerate step when no manifest gate is left, and runs the gates when no regenerate is due', async () => {
    const spec = { repo: 'web', commands: ['npm run gen'] };
    const s = spy(() => undefined);
    const res = await rerun({ runGates: s.runGates, regenerateFor: () => spec, gatesFor: () => [] })(ticketId, [regenGate(), failed()], 'uat');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.gates).toEqual([]);
    expect(s.calls[0]!.opts.regenerate).toBe(spec);
    expect(res[1]).toEqual({ exitCode: null, cannotRerun: true, summary: 'unit (web) is no longer a manifest gate' });
  });

  it('matches a manifest gate only on the same command and the same arguments', async () => {
    const s = spy(() => undefined);
    const ask = (g: Partial<ResolvedGate>, f: Partial<FailedGate>) => rerun({ runGates: s.runGates, gatesFor: () => [resolved(g)] })(ticketId, [failed(f)], 'uat');
    expect((await ask({ command: 'pnpm' }, {}))[0]).toMatchObject({ cannotRerun: true });
    expect((await ask({ args: ['ab'] }, { args: ['a', 'b'] }))[0]).toMatchObject({ cannotRerun: true });
    expect((await ask({ args: ['a', 'b'] }, { args: ['a', 'b'] }))[0]).not.toMatchObject({ cannotRerun: true });
  });

  it('cannot re-run any gate when the host gives no manifest gates', async () => {
    const s = spy(() => undefined);
    const none = await makeGateRerun({ store, runnerFor: base.runnerFor, runGates: s.runGates })(ticketId, [failed()], 'uat');
    const undef = await rerun({ runGates: s.runGates, gatesFor: () => undefined })(ticketId, [failed()], 'uat');
    expect(none[0]).toMatchObject({ cannotRerun: true });
    expect(undef[0]).toMatchObject({ cannotRerun: true });
    expect(s.calls).toHaveLength(0);
  });

  it('finds the worktree of a regenerate row from its name when the row has no repo, and of no other row', async () => {
    const s = spy(() => undefined);
    const spec = { repo: 'web', commands: ['x'] };
    await rerun({ runGates: s.runGates, regenerateFor: () => spec })(ticketId, [regenGate({ repo: null })], 'uat');
    expect(s.calls[0]!.cwd).toBe('/wt/web');
    const res = await rerun({ runGates: s.runGates })(ticketId, [failed({ repo: null, gateName: 'regenerate (web)' })], 'uat');
    expect(res).toEqual([{ exitCode: null, summary: 're-run error: no worktree for repo (none)' }]);
  });

  it('returns the results in the order of the failed rows across repos, and keeps one repo error from the others', async () => {
    const s = spy((o, cwd) => {
      if (cwd === '/wt/api') throw 'plain failure';
      o.onGateComplete('unit', 0, 'a', 'b', 0, 'ok');
    });
    const gatesFor = (_t: number, repo: string) => (repo === 'api' ? [resolved()] : [resolved()]);
    const res = await rerun({ runGates: s.runGates, gatesFor })(
      ticketId,
      [failed(), failed({ repo: 'api', gateName: 'unit (api)' }), failed({ gateName: 'unit again (web)' })],
      'uat',
    );
    expect(res).toEqual([{ exitCode: 0, summary: null }, { exitCode: null, summary: 're-run error: plain failure' }, { exitCode: 0, summary: null }]);
  });

  it('uses the real gate runner when no fake is injected', async () => {
    const run = vi.fn<GateProcessRunner>(async () => ok());
    await makeGateRerun({ store, runnerFor: () => run, gatesFor: () => [resolved()] })(ticketId, [failed()], 'uat');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('makeRecoverRefusal gating', () => {
  it('runs no re-run for another stage, or for another refusal', async () => {
    const rerun = vi.fn(async () => ({ kind: 'passed' as const, stage: 'uat' as const }));
    const recover = makeRecoverRefusal(7, { rerun });
    expect(await recover('uat' as never, NO_NEW_COMMIT_REASON)).toBeUndefined();
    expect(await recover('fix', 'something else')).toBeUndefined();
    expect(rerun).not.toHaveBeenCalled();
  });

  it('logs the outcome kind of the ticket', async () => {
    const debug = vi.fn();
    await makeRecoverRefusal(7, { rerun: async () => ({ kind: 'not-applicable' as const }), debug })('fix', NO_NEW_COMMIT_REASON);
    expect(debug).toHaveBeenCalledWith('[fix-rerun] ticket 7: not-applicable');
  });
});

describe('makeRequestedRerunSweep failure', () => {
  it('reports the message of a failed sweep', async () => {
    const debug = vi.fn();
    const broken = { db: { prepare: () => { throw new Error('db gone'); } } } as unknown as Store;
    await makeRequestedRerunSweep({ store: broken, runnerFor: () => vi.fn() as never, projectId: () => 1, debug })();
    expect(debug).toHaveBeenCalledWith('[fix-rerun] sweep failed: db gone');
  });
});
