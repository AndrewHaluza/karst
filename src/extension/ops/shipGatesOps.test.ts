import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runShipGates, runShipGatesReport, scopeLinesOf } from './shipGatesOps.js';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { currentDeliverRun, listDeliverResults } from '../../store/deliverRuns.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import type { GitRunner } from '../../integrations/git.js';
import { NO_UI_CHANGE_REASON } from '../../workflow/gates/uiScope.js';

const repoWith = (scripts: Record<string, string>) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts }));
  return { repo: 'r', number: 1, branch: 'b', cwd };
};
const exits = (code: number): GateProcessRunner => async () => ({ kind: 'completed', exitCode: code, output: code === 0 ? 'ok' : 'boom: broke' });

describe('runShipGates', () => {
  it('passes when every probed gate exits 0', async () => {
    expect(await runShipGates([repoWith({ test: 'x' })], { uat: undefined, runProcess: exits(0) })).toBeNull();
  });
  it('names the failing gate and repo', async () => {
    const r = await runShipGates([repoWith({ test: 'x' })], { uat: undefined, runProcess: exits(1) });
    expect(r).toMatch(/^r: gate "test" failed \(exit 1\)/);
  });
  it('runs nothing and passes when the repo answers no gate', async () => {
    expect(await runShipGates([repoWith({})], { uat: undefined, runProcess: exits(1) })).toBeNull();
  });
  it('puts the failing output summary after the gate name', async () => {
    const r = await runShipGates([repoWith({ test: 'x' })], { uat: undefined, runProcess: exits(2) });
    expect(r).toBe('r: gate "test" failed (exit 2) — boom: broke');
  });
  it('stops at the first failing repo and never runs later ones', async () => {
    const seen: string[] = [];
    const runProcess: GateProcessRunner = async (_c, _a, cwd) => { seen.push(cwd); return { kind: 'completed', exitCode: 1, output: '' }; };
    const a = repoWith({ test: 'x' });
    const b = { ...repoWith({ test: 'x' }), repo: 'second' };
    const r = await runShipGates([a, b], { uat: undefined, runProcess });
    expect(r).toMatch(/^r: gate "test" failed \(exit 1\)/);
    expect(seen).toEqual([a.cwd]);
  });

  it('tells a repo that never gated because an earlier one failed (T1315)', async () => {
    const runProcess: GateProcessRunner = async () => ({ kind: 'completed', exitCode: 1, output: 'boom' });
    const a = repoWith({ test: 'x' });
    const b = { ...repoWith({ test: 'x' }), repo: 'second' };
    const first = await runShipGatesReport([a, b], { uat: undefined, runProcess });
    expect(first.failed.map((g) => g.name)).toEqual(['test']);
    expect(first.failed[0]?.output).toBe('boom');
    expect(first.incomplete).toBe(true);
    const last = await runShipGatesReport([a, b], {
      uat: undefined,
      runProcess: async (_c, _a, cwd) => ({ kind: 'completed', exitCode: cwd === a.cwd ? 0 : 1, output: cwd === a.cwd ? 'ok' : 'boom' }),
    });
    expect(last.incomplete).toBeUndefined();
    expect(last.failed.map((g) => g.name)).toEqual(['test']);
  });
  it('a declared command gate runs without a package.json', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const uat = { gates: [{ name: 'lint', kind: 'command', command: 'ruff', args: ['check'] }], repositories: {} } as never;
    const ran: string[] = [];
    const runProcess: GateProcessRunner = async (cmd) => { ran.push(cmd); return { kind: 'completed', exitCode: 0, output: '' }; };
    expect(await runShipGates([{ repo: 'py', number: 1, branch: 'b', cwd }], { uat, runProcess })).toBeNull();
    expect(ran).toEqual(['ruff']);
  });
  it('blocks with the repo and reason when the probe cannot read package.json', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    mkdirSync(join(cwd, 'package.json'));
    const report = await runShipGatesReport([{ repo: 'io', number: 1, branch: 'b', cwd }], { uat: undefined, runProcess: exits(0) });
    expect(report.reason).toMatch(/^io: cannot read package\.json/);
    // No gate ran, so there is nothing for the environment re-run to look at (T1315).
    expect(report.failed).toEqual([]);
  });
  it('treats a gate that never started (no exit code) as no verdict, not a failure', async () => {
    const runProcess: GateProcessRunner = async () => ({ kind: 'spawnFailed', message: 'ENOENT' }) as never;
    expect(await runShipGates([repoWith({ test: 'x' })], { uat: undefined, runProcess })).toBeNull();
  });
  it('blocks when a host-only gate was refused by the host boundary (no verdict is not a pass)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const uat = { gates: [{ name: 'docs', kind: 'command', command: 'x', args: [], sandbox: 'host' }], repositories: {} } as never;
    const refuse: GateProcessRunner = async () => ({ kind: 'spawnFailed', message: 'no exec', output: 'refused' }) as never;
    const report = await runShipGatesReport([{ repo: 'sb', number: 1, branch: 'b', cwd }], { uat, runProcess: refuse, hostProcess: refuse });
    expect(report.reason).toBe('sb: gate "docs" could not run (refused by the host boundary), so the merge is not verified');
    // A gate that never ran has no output for the environment classifier: it is never a re-run candidate (T1315).
    expect(report.failed).toEqual([]);
    expect(await runShipGates([{ repo: 'sb', number: 1, branch: 'b', cwd }], { uat, runProcess: refuse, hostProcess: refuse })).toBe(report.reason);
  });
  it('a refused gate blocks with no re-run candidate even when an earlier gate failed (T1315)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const uat = { gates: [
      { name: 'lint', kind: 'command', command: 'lint', args: [] },
      { name: 'docs', kind: 'command', command: 'x', args: [], sandbox: 'host' },
    ], repositories: {} } as never;
    const fail: GateProcessRunner = async () => ({ kind: 'completed', exitCode: 1, output: 'base check skipped: some vitest failures are not parseable' });
    const refuse: GateProcessRunner = async () => ({ kind: 'spawnFailed', message: 'no exec', output: 'refused' }) as never;
    const report = await runShipGatesReport([{ repo: 'sb', number: 1, branch: 'b', cwd }], { uat, runProcess: fail, hostProcess: refuse });
    expect(report.reason).toBe('sb: gate "docs" could not run (refused by the host boundary), so the merge is not verified');
    expect(report.failed).toEqual([]);
  });
  it('runs every gate with the ticket citations as PR_BODY and its base branch', async () => {
    const argsSeen: Array<readonly string[]> = [];
    const runProcess: GateProcessRunner = async (_c, args) => { argsSeen.push(args); return { kind: 'completed', exitCode: 0, output: '' }; };
    const pr = repoWith({ test: 'x' });
    const gateEnv = (p: { repo: string }) => ({ prBody: `@arch:CLI-02 — for ${p.repo}`, baseRef: 'develop' });
    expect(await runShipGates([pr], { uat: undefined, runProcess, gateEnv })).toBeNull();
    expect(argsSeen[0]).toEqual(expect.arrayContaining(['PR_BODY=@arch:CLI-02 — for r', 'BASE_REF=develop']));
  });
});

describe('runShipGates evidence (T1018)', () => {
  const twoGates = { gates: [{ name: 'unit', kind: 'command', command: 'u', args: [] }, { name: 'docs', kind: 'command', command: 'd', args: [] }], repositories: {} } as never;
  const setup = () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    return { store, ticketId, pr: { repo: 'r', number: 1, branch: 'b', cwd } };
  };
  const byCommand = (codes: Record<string, number>): GateProcessRunner => async (cmd) => ({ kind: 'completed', exitCode: codes[cmd] ?? 0, output: codes[cmd] ? 'boom: broke' : 'ok' });

  it('opens a run first and writes one result per gate with the head SHA', async () => {
    const { store, ticketId, pr } = setup();
    const out = await runShipGates([pr], { uat: twoGates, runProcess: byCommand({}), evidence: { store, ticketId }, headSha: async () => 'f'.repeat(40) });
    expect(out).toBeNull();
    expect(listDeliverResults(store, ticketId).map((r) => [r.gateName, r.exitCode, r.headSha])).toEqual([['unit', 0, 'f'.repeat(40)], ['docs', 0, 'f'.repeat(40)]]);
    expect(currentDeliverRun(store, ticketId)).toMatchObject({ state: 'passed', gates: ['unit', 'docs'], finished: 2 });
  });

  it('records the slot wait of a gate apart from its run time (T1248)', async () => {
    const { store, ticketId, pr } = setup();
    const waiting: GateProcessRunner = async (cmd) => ({ kind: 'completed', exitCode: 0, output: 'ok', ...(cmd === 'u' ? { waitMs: 400 } : {}) });
    await runShipGates([pr], { uat: twoGates, runProcess: waiting, evidence: { store, ticketId }, headSha: async () => 'f'.repeat(40) });
    expect(listDeliverResults(store, ticketId).map((r) => [r.gateName, r.waitMs])).toEqual([['unit', 400], ['docs', 0]]);
  });

  it('records every gate also when the first gate fails, and keeps the failure summary', async () => {
    const { store, ticketId, pr } = setup();
    const out = await runShipGates([pr], { uat: twoGates, runProcess: byCommand({ u: 3 }), evidence: { store, ticketId }, headSha: async () => 'a'.repeat(40) });
    expect(out).toMatch(/gate "unit" failed \(exit 3\)/);
    const rows = listDeliverResults(store, ticketId);
    expect(rows.map((r) => [r.gateName, r.exitCode])).toEqual([['unit', 3], ['docs', 0]]);
    expect(rows[0]!.summary).toBe('boom: broke');
    expect(currentDeliverRun(store, ticketId)?.state).toBe('failed');
  });

  it('reports a gate that waits for a slot to the live sink, then the run, then the end', async () => {
    const { store, ticketId, pr } = setup();
    const events: string[] = [];
    const runProcess: GateProcessRunner = async (_c, _a, _cwd, options) => {
      options?.onSlotWait?.({ kind: 'sandbox', held: 2, limit: 2 });
      options?.onSlotTaken?.();
      return { kind: 'completed', exitCode: 0, output: '' };
    };
    const live = { start: (g: string) => events.push(`start:${g}`), wait: (g: string, w: { kind: string }) => events.push(`wait:${g}:${w.kind}`), end: (g: string) => events.push(`end:${g}`) };
    await runShipGates([pr], { uat: twoGates, runProcess, evidence: { store, ticketId }, headSha: async () => null, live });
    expect(events).toEqual(['start:unit', 'wait:unit:sandbox', 'start:unit', 'end:unit', 'start:docs', 'wait:docs:sandbox', 'start:docs', 'end:docs']);
  });

  it('names a waiting survivor in current_gate, and clears the live entry of a gate that threw', async () => {
    const { store, ticketId, pr } = setup();
    const progress: (string | null | undefined)[] = [];
    const runProcess: GateProcessRunner = async (_c, _a, _cwd, options) => {
      options?.onSlotWait?.({ kind: 'sandbox', held: 1, limit: 1 });
      progress.push(currentDeliverRun(store, ticketId)?.currentGate);
      return { kind: 'completed', exitCode: 0, output: '' };
    };
    await runShipGates([pr], { uat: twoGates, runProcess, evidence: { store, ticketId }, headSha: async () => null });
    expect(progress).toEqual(['unit', 'docs']);
    const ended: string[] = [];
    const live = { start: () => undefined, wait: () => undefined, end: (g: string) => ended.push(g) };
    const boom: GateProcessRunner = async () => { throw new Error('boom'); };
    await expect(runShipGates([pr], { uat: twoGates, runProcess: boom, evidence: { store, ticketId }, headSha: async () => null, live })).rejects.toThrow();
    expect(ended).toEqual(expect.arrayContaining(['unit', 'docs']));
  });

  it('names the gate that waits in current_gate, also when another gate started after it', async () => {
    const { store, ticketId } = setup();
    const pr = repoWith({ test: 'x', 'test:visual:docker': 'x' });
    const uat = { gates: [{ name: 'visual', kind: 'script', script: 'test:visual:docker' }, { name: 'unit', kind: 'script', script: 'test' }], repositories: {} } as never;
    let unitStarted!: () => void;
    const started = new Promise<void>((r) => { unitStarted = r; });
    let visualRead!: () => void;
    const read = new Promise<void>((r) => { visualRead = r; });
    const seen: (string | null | undefined)[] = [];
    const runProcess: GateProcessRunner = async (_c, args, _cwd, options) => {
      if (args.includes('test:visual:docker')) {
        await started;
        seen.push(currentDeliverRun(store, ticketId)?.currentGate);
        options?.onSlotWait?.({ kind: 'sandbox', held: 1, limit: 1 });
        seen.push(currentDeliverRun(store, ticketId)?.currentGate);
        visualRead();
      } else {
        unitStarted();
        await read;
      }
      return { kind: 'completed', exitCode: 0, output: '' };
    };
    await runShipGates([pr], { uat, runProcess, uiChanged: true, evidence: { store, ticketId }, headSha: async () => null });
    expect(seen).toEqual(['unit', 'visual']);
  });

  it('reports a slot wait with no evidence store without a deliver write', async () => {
    const pr = repoWith({ test: 'x' });
    const waits: string[] = [];
    const live = { start: () => undefined, wait: (g: string) => waits.push(g), end: () => undefined };
    const runProcess: GateProcessRunner = async (_c, _a, _cwd, options) => {
      options?.onSlotWait?.({ kind: 'sandbox', held: 1, limit: 1 });
      return { kind: 'completed', exitCode: 0, output: '' };
    };
    const uat = { gates: [{ name: 'unit', kind: 'script', script: 'test' }], repositories: {} } as never;
    await runShipGates([pr], { uat, runProcess, live });
    expect(waits).toEqual(['unit']);
  });

  it('pushes one progress update for each gate start and each gate wait, with no live sink', async () => {
    const { store, ticketId, pr } = setup();
    let progress = 0;
    const runProcess: GateProcessRunner = async (_c, _a, _cwd, options) => {
      options?.onSlotWait?.({ kind: 'sandbox', held: 1, limit: 1 });
      return { kind: 'completed', exitCode: 0, output: '' };
    };
    await runShipGates([pr], { uat: twoGates, runProcess, evidence: { store, ticketId }, headSha: async () => null, onProgress: () => { progress += 1; } });
    expect(progress).toBeGreaterThanOrEqual(4);
  });

  it('shows the running gate while it runs', async () => {
    const { store, ticketId, pr } = setup();
    const seen: Array<string | null | undefined> = [];
    const runProcess: GateProcessRunner = async () => { seen.push(currentDeliverRun(store, ticketId)?.currentGate); return { kind: 'completed', exitCode: 0, output: '' }; };
    await runShipGates([pr], { uat: twoGates, runProcess, evidence: { store, ticketId }, headSha: async () => null });
    expect(seen).toEqual(['unit', 'docs']);
  });

  it('a stopped run keeps the results of the gates that finished and records no result for the killed gate', async () => {
    const { store, ticketId, pr } = setup();
    const ac = new AbortController();
    let n = 0;
    const runProcess: GateProcessRunner = async () => {
      n += 1;
      if (n === 2) { ac.abort(); return { kind: 'aborted' } as never; }
      return { kind: 'completed', exitCode: 0, output: '' };
    };
    const report = await runShipGatesReport([pr], { uat: twoGates, runProcess, signal: ac.signal, evidence: { store, ticketId }, headSha: async () => 'a'.repeat(40) });
    expect(report.reason).toMatch(/gate run was stopped/);
    expect(report.failed).toEqual([]);
    expect(listDeliverResults(store, ticketId).map((r) => r.gateName)).toEqual(['unit']);
    expect(currentDeliverRun(store, ticketId)?.state).toBe('stopped');
  });

  it('forwards gate output to the console sink', async () => {
    const { pr } = setup();
    const chunks: string[] = [];
    const runProcess: GateProcessRunner = async (_c, _a, _cwd, o) => { o?.onOutput?.({ stream: 'stdout', text: 'line' }); return { kind: 'completed', exitCode: 0, output: 'line' }; };
    await runShipGates([pr], { uat: twoGates, runProcess, onOutput: (g, c) => chunks.push(`${g}:${c.text}`) });
    expect(chunks).toEqual(['unit:line', 'docs:line']);
  });

  it('records nothing and opens no run without an evidence target', async () => {
    const { store, ticketId, pr } = setup();
    expect(await runShipGates([pr], { uat: twoGates, runProcess: byCommand({}), headSha: async () => 'a'.repeat(40) })).toBeNull();
    expect(currentDeliverRun(store, ticketId)).toBeNull();
  });

  it('opens no run when no repo answers a gate', async () => {
    const { store, ticketId, pr } = setup();
    expect(await runShipGates([pr], { uat: undefined, evidence: { store, ticketId } })).toBeNull();
    expect(currentDeliverRun(store, ticketId)).toBeNull();
  });

  it('stores a null head when no head reader is given, and the run head comes from the first repo', async () => {
    const { store, ticketId, pr } = setup();
    await runShipGates([pr], { uat: twoGates, runProcess: byCommand({}), evidence: { store, ticketId } });
    expect(currentDeliverRun(store, ticketId)?.headSha).toBeNull();
    expect(listDeliverResults(store, ticketId).map((r) => r.headSha)).toEqual([null, null]);
  });

  it('stops after the first failing repo and records only the gates that ran', async () => {
    const { store, ticketId, pr } = setup();
    const other = { ...pr, repo: 'r2', cwd: mkdtempSync(join(tmpdir(), 'ship-gates-')) };
    const out = await runShipGates([pr, other], { uat: twoGates, runProcess: byCommand({ u: 1 }), evidence: { store, ticketId }, headSha: async (cwd) => (cwd === pr.cwd ? 'a'.repeat(40) : 'b'.repeat(40)) });
    expect(out).toMatch(/^r: gate "unit" failed/);
    expect(listDeliverResults(store, ticketId).map((r) => [r.repo, r.gateName, r.headSha])).toEqual([['r', 'unit', 'a'.repeat(40)], ['r', 'docs', 'a'.repeat(40)]]);
  });

  it('keeps no summary for a passing gate and pushes progress at start, at each gate end and at close', async () => {
    const { store, ticketId, pr } = setup();
    let pushes = 0;
    await runShipGates([pr], { uat: twoGates, runProcess: byCommand({}), evidence: { store, ticketId }, onProgress: () => { pushes += 1; } });
    expect(listDeliverResults(store, ticketId).map((r) => r.summary)).toEqual([null, null]);
    expect(pushes).toBe(1 + 2 * 2 + 1);
  });

  it('records a failure for a required script gate the repo cannot answer, and never spawns it', async () => {
    const { store, ticketId } = setup();
    const pr = repoWith({ test: 'x' });
    const uat = { gates: [{ name: 'lint', kind: 'script', script: 'lint' }], repositories: {} } as never;
    let spawned = 0;
    const runProcess: GateProcessRunner = async () => { spawned += 1; return { kind: 'completed', exitCode: 0, output: '' }; };
    const out = await runShipGates([pr], { uat, runProcess, evidence: { store, ticketId }, headSha: async () => 'c'.repeat(40) });
    expect(out).toMatch(/^r: gate "lint" failed \(exit 1\)/);
    expect(spawned).toBe(0);
    expect(listDeliverResults(store, ticketId)).toMatchObject([{ gateName: 'lint', exitCode: 1, headSha: 'c'.repeat(40) }]);
  });

  it('runs a script gate the repo defines', async () => {
    const { store, ticketId } = setup();
    const pr = repoWith({ lint: 'x' });
    const uat = { gates: [{ name: 'lint', kind: 'script', script: 'lint' }], repositories: {} } as never;
    expect(await runShipGates([pr], { uat, runProcess: byCommand({}), evidence: { store, ticketId } })).toBeNull();
    expect(listDeliverResults(store, ticketId)).toMatchObject([{ gateName: 'lint', exitCode: 0 }]);
  });
});

describe('runShipGates UI cut (same rule as UAT)', () => {
  const uiGates = { gates: [{ name: 'unit', kind: 'script', script: 'test' }, { name: 'visual', kind: 'script', script: 'test:visual:docker' }, { name: 'layout', kind: 'script', script: 'test:layout:docker' }], repositories: {} } as never;
  const scripts = { test: 'x', 'test:visual:docker': 'x', 'test:layout:docker': 'x' };
  const names = ['test', 'test:visual:docker', 'test:layout:docker'];
  const gitDiff = (files: string[], failDiff = false): GitRunner => async (args) => {
    if (args[0] === 'merge-base') return { exitCode: 0, stdout: 'abc\n', stderr: '' };
    if (args[0] === 'diff') return failDiff ? { exitCode: 128, stdout: '', stderr: 'bad' } : { exitCode: 0, stdout: files.join('\0') + '\0', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const run = async (git: GitRunner) => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
    const ran: string[] = [];
    const runProcess: GateProcessRunner = async (_cmd, args) => { ran.push(args.find((a) => names.includes(a)) ?? '?'); return { kind: 'completed', exitCode: 0, output: '' }; };
    const pr = repoWith(scripts);
    const out = await runShipGates([pr], { uat: uiGates, runProcess, git, gateEnv: () => ({ prBody: '', baseRef: 'develop' }), evidence: { store, ticketId } });
    return { out, ran, store, ticketId };
  };

  it('runs no visual/layout gate and records both as skipped when the diff has no UI path', async () => {
    const { out, ran, store, ticketId } = await run(gitDiff(['src/store/a.ts']));
    expect(out).toBeNull();
    expect(ran).toEqual(['test']);
    expect(currentDeliverRun(store, ticketId)?.gates).toEqual(['unit', 'visual', 'layout']);
    const rows = listDeliverResults(store, ticketId);
    expect(rows.map((r) => [r.gateName, r.exitCode])).toEqual([['visual', null], ['layout', null], ['unit', 0]]);
    expect(rows[0]!.summary).toBe(NO_UI_CHANGE_REASON);
    expect(rows[1]!.summary).toBe(NO_UI_CHANGE_REASON);
  });
  it('names a gate that still runs as the current gate after the other lane ended', async () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
    let sampled: string | null | undefined;
    const runProcess: GateProcessRunner = async (_cmd, args) => {
      // The UI lane starts first; the main lane (unit, started last) ends first. The visual gate samples later.
      if (args.includes('test:visual:docker')) {
        await new Promise((r) => setTimeout(r, 40));
        sampled = currentDeliverRun(store, ticketId)?.currentGate;
      }
      return { kind: 'completed', exitCode: 0, output: '' };
    };
    await runShipGates([repoWith(scripts)], { uat: uiGates, runProcess, git: gitDiff(['src/ui/a.tsx']), gateEnv: () => ({ prBody: '', baseRef: 'develop' }), evidence: { store, ticketId } });
    expect(sampled).toBe('visual');
  });
  it('runs the UI gates when the diff has a UI path', async () => {
    const { ran } = await run(gitDiff(['src/ui/a.tsx']));
    // The UI lane and the main lane start together, so the start order is not the manifest order.
    expect([...ran].sort()).toEqual([...names].sort());
  });
  it('runs the UI gates when the diff is unreadable', async () => {
    const { ran } = await run(gitDiff([], true));
    // The UI lane and the main lane start together, so the start order is not the manifest order.
    expect([...ran].sort()).toEqual([...names].sort());
  });
  it('runs the UI gates when no base ref is known', async () => {
    const pr = repoWith(scripts);
    const ran: string[] = [];
    const runProcess: GateProcessRunner = async (_cmd, args) => { ran.push(args.find((a) => names.includes(a)) ?? '?'); return { kind: 'completed', exitCode: 0, output: '' }; };
    await runShipGates([pr], { uat: uiGates, runProcess, git: gitDiff(['src/store/a.ts']) });
    // The UI lane and the main lane start together, so the start order is not the manifest order.
    expect([...ran].sort()).toEqual([...names].sort());
  });

  it('runs only the named gates and records the run as after-take-over', async () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
    const uat = { gates: [
      { name: 'unit', kind: 'command', command: 'a' }, { name: 'lint', kind: 'command', command: 'b' }, { name: 'types', kind: 'command', command: 'c' },
    ], repositories: {} } as never;
    const ran: string[] = [];
    const runProcess: GateProcessRunner = async (cmd) => { ran.push(cmd); return { kind: 'completed', exitCode: 0, output: '' }; };
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const r = await runShipGates([{ repo: 'r', number: 1, branch: 'b', cwd }], {
      uat, runProcess, evidence: { store, ticketId }, headSha: async () => 'c'.repeat(40), only: ['lint', 'types'], kind: 'after-take-over',
    });
    expect(r).toBeNull();
    expect(ran).toEqual(['b', 'c']);
    expect(currentDeliverRun(store, ticketId)).toMatchObject({ kind: 'after-take-over', state: 'passed', gates: ['lint', 'types'], headSha: 'c'.repeat(40) });
    expect(listDeliverResults(store, ticketId).map((x) => [x.gateName, x.headSha])).toEqual([['lint', 'c'.repeat(40)], ['types', 'c'.repeat(40)]]);
  });

  it('reports the id of the run it opened, and none when no gate is planned', async () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-2', title: 't' }).id;
    const uat = { gates: [{ name: 'lint', kind: 'command', command: 'b' }], repositories: {} } as never;
    const runProcess: GateProcessRunner = async () => ({ kind: 'completed', exitCode: 0, output: '' });
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const opened: number[] = [];
    await runShipGates([{ repo: 'r', number: 1, branch: 'b', cwd }], { uat, runProcess, evidence: { store, ticketId }, onRunOpened: (id) => opened.push(id) });
    expect(opened).toEqual([currentDeliverRun(store, ticketId)!.id]);
  });

  it('opens no run and runs no gate when the signal aborted while the run was planned', async () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-4', title: 't' }).id;
    const uat = { gates: [{ name: 'lint', kind: 'command', command: 'b' }], repositories: {} } as never;
    const ran: string[] = [];
    const runProcess: GateProcessRunner = async (cmd) => { ran.push(cmd); return { kind: 'completed', exitCode: 0, output: '' }; };
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const ac = new AbortController();
    const opened: number[] = [];
    const out = await runShipGatesReport([{ repo: 'r', number: 1, branch: 'b', cwd }], {
      uat, runProcess, evidence: { store, ticketId }, signal: ac.signal, onRunOpened: (id) => opened.push(id),
      headSha: async () => { ac.abort(); return 'd'.repeat(40); },
    });
    expect(out.reason).toBe('stopped: a newer push superseded this run');
    expect(out.failed).toEqual([]);
    expect(ran).toEqual([]);
    expect(opened).toEqual([]);
    expect(currentDeliverRun(store, ticketId)).toBeNull();
  });

  it('opens no run and runs no gate when the signal was already aborted', async () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-5', title: 't' }).id;
    const uat = { gates: [{ name: 'lint', kind: 'command', command: 'b' }], repositories: {} } as never;
    const ran: string[] = [];
    const runProcess: GateProcessRunner = async (cmd) => { ran.push(cmd); return { kind: 'completed', exitCode: 0, output: '' }; };
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const ac = new AbortController();
    ac.abort();
    const heads = vi.fn(async () => 'e'.repeat(40));
    const out = await runShipGatesReport([{ repo: 'r', number: 1, branch: 'b', cwd }], {
      uat, runProcess, evidence: { store, ticketId }, signal: ac.signal, headSha: heads,
    });
    expect(out.reason).toBe('stopped: a newer push superseded this run');
    expect(out.failed).toEqual([]);
    expect(ran).toEqual([]);
    // The guard saves the head read too: an aborted run must not touch git before it returns.
    expect(heads).not.toHaveBeenCalled();
    expect(currentDeliverRun(store, ticketId)).toBeNull();
  });

  it('reports every failed gate of a mixed run with its repo, output and summary (T1315)', async () => {
    const uat = { gates: [
      { name: 'lint', kind: 'command', command: 'a' }, { name: 'unit', kind: 'command', command: 'b' }, { name: 'types', kind: 'command', command: 'c' },
    ], repositories: {} } as never;
    const runProcess: GateProcessRunner = async (cmd) => {
      if (cmd === 'b') return { kind: 'completed', exitCode: 1, output: 'base check skipped: some vitest failures are not parseable' };
      if (cmd === 'c') return { kind: 'completed', exitCode: 2, output: 'src/a.ts(2,3): error TS2322' };
      return { kind: 'completed', exitCode: 0, output: 'ok' };
    };
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const report = await runShipGatesReport([{ repo: 'r', number: 1, branch: 'b', cwd }], { uat, runProcess });
    // The reason names the FIRST failure in run order; `failed` names every failure, so the environment guard sees the
    // whole batch (one signed gate beside one real failure must not be retried).
    expect(report.reason).toBe('r: gate "unit" failed (exit 1) — base check skipped: some vitest failures are not parseable');
    expect(report.failed.map((g) => [g.name, g.repo])).toEqual([['unit', 'r'], ['types', 'r']]);
    expect(report.failed[0]).toMatchObject({ name: 'unit', repo: 'r', output: 'base check skipped: some vitest failures are not parseable', summary: 'base check skipped: some vitest failures are not parseable' });
  });

  it('lists only the gates that exited non-zero, never one that did not run (T1315)', async () => {
    // A discovered script whose binary vanished has no verdict (exit code null): it must not reach the re-run set.
    const runProcess: GateProcessRunner = async (_c, args) =>
      args.includes('e2e') ? ({ kind: 'spawnFailed', message: 'ENOENT', output: '' } as never) : { kind: 'completed', exitCode: 1, output: 'boom: broke' };
    const report = await runShipGatesReport([repoWith({ test: 'x', e2e: 'y' })], { uat: undefined, runProcess });
    expect(report.reason).toMatch(/^r: gate "(test|e2e)" failed \(exit 1\)/);
    expect(report.failed.map((g) => g.name)).toEqual(['test']);
  });

  it('does not report a run id when no run is opened (no evidence target)', async () => {
    const uat = { gates: [{ name: 'lint', kind: 'command', command: 'b' }], repositories: {} } as never;
    const runProcess: GateProcessRunner = async () => ({ kind: 'completed', exitCode: 0, output: '' });
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const opened: number[] = [];
    await runShipGates([{ repo: 'r', number: 1, branch: 'b', cwd }], { uat, runProcess, onRunOpened: (id) => opened.push(id) });
    expect(opened).toEqual([]);
  });

  it('keeps only the named gates among the skipped ones too', async () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-3', title: 't' }).id;
    const runProcess: GateProcessRunner = async () => ({ kind: 'completed', exitCode: 0, output: '' });
    await runShipGates([repoWith(scripts)], {
      uat: uiGates, runProcess, git: gitDiff(['src/store/a.ts']), gateEnv: () => ({ prBody: '', baseRef: 'develop' }),
      evidence: { store, ticketId }, only: ['unit', 'visual'],
    });
    expect(currentDeliverRun(store, ticketId)?.gates).toEqual(['unit', 'visual']);
    expect(listDeliverResults(store, ticketId).map((r) => r.gateName).sort()).toEqual(['unit', 'visual']);
  });
  it('stops at the first failing repository and runs no later one', async () => {
    const uat = { gates: [{ name: 'lint', kind: 'command', command: 'b' }], repositories: {} } as never;
    const ran: string[] = [];
    const runProcess: GateProcessRunner = async (cmd) => { ran.push(cmd); return { kind: 'completed', exitCode: 1, output: '' }; };
    const a = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const b = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const r = await runShipGates([{ repo: 'r1', number: 1, branch: 'b', cwd: a }, { repo: 'r2', number: 2, branch: 'b', cwd: b }], { uat, runProcess });
    expect(r).not.toBeNull();
    expect(ran).toHaveLength(1);
  });
});

describe('runShipGates on a base-moved merge (D541)', () => {
  const uat = { gates: [{ name: 'unit', kind: 'script', script: 'test' }, { name: 'visual', kind: 'script', script: 'test:visual:docker' }], repositories: {} } as never;
  const scripts = { test: 'x', 'test:visual:docker': 'x' };
  const run = async (uiChanged: boolean, uiSkipReason?: string) => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-9', title: 't' }).id;
    const ran: string[] = [];
    const runProcess: GateProcessRunner = async (_c, args) => { ran.push(args.find((a) => a === 'test' || a === 'test:visual:docker') ?? '?'); return { kind: 'completed', exitCode: 0, output: '' }; };
    // No git runner: the cut must come from the base delta, never from a diff of the merged tree against the base.
    await runShipGates([repoWith(scripts)], { uat, runProcess, uiChanged, ...(uiSkipReason ? { uiSkipReason } : {}), kind: 'base-moved', evidence: { store, ticketId }, headSha: async () => 'd'.repeat(40) });
    return { ran, store, ticketId };
  };

  it('cuts the visual gate when the base delta holds no UI path, and records the cut', async () => {
    const { ran, store, ticketId } = await run(false);
    expect(ran).toEqual(['test']);
    expect(currentDeliverRun(store, ticketId)).toMatchObject({ kind: 'base-moved', headSha: 'd'.repeat(40), gates: ['unit', 'visual'] });
    expect(listDeliverResults(store, ticketId).find((r) => r.gateName === 'visual')).toMatchObject({ exitCode: null, summary: NO_UI_CHANGE_REASON });
  });
  it('records the reason of the cut when the ticket diff holds no UI path', async () => {
    const reason = 'skipped: no UI path in the ticket diff';
    const { ran, store, ticketId } = await run(false, reason);
    expect(ran).toEqual(['test']);
    expect(listDeliverResults(store, ticketId).find((r) => r.gateName === 'visual')).toMatchObject({ exitCode: null, summary: reason });
  });
  it('runs the visual gate when the base delta holds a UI path', async () => {
    expect([...(await run(true)).ran].sort()).toEqual(['test', 'test:visual:docker']);
  });
});

describe('runShipGates scope evidence on a base-moved merge (@arch:GATE-BASE-MOVED)', () => {
  const uat = { gates: [{ name: 'visual', kind: 'script', script: 'test:visual:docker' }], repositories: {} } as never;
  const output = 'noise\nfull: the merge base moved\nvisual: running ticketForm — 3 of 90 tests; full sweep runs in CI\n';
  const run = async (mergedBaseSha?: string) => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-9', title: 't' }).id;
    const seen: string[][] = [];
    const runProcess: GateProcessRunner = async (_c, args) => { seen.push([...args]); return { kind: 'completed', exitCode: 0, output }; };
    await runShipGates([repoWith({ 'test:visual:docker': 'x' })], { uat, runProcess, uiChanged: true, ...(mergedBaseSha ? { mergedBaseSha } : {}), kind: 'base-moved', evidence: { store, ticketId }, headSha: async () => 'd'.repeat(40) });
    return { seen, rows: listDeliverResults(store, ticketId) };
  };
  it('passes the merged base sha to the gate and keeps the scope lines in the row', async () => {
    const { seen, rows } = await run('b'.repeat(40));
    expect(seen[0]).toContain(`KARST_MERGED_BASE_SHA=${'b'.repeat(40)}`);
    expect(rows[0]?.summary).toBe('full: the merge base moved\nvisual: running ticketForm — 3 of 90 tests; full sweep runs in CI');
  });
  it('leaves a run without a merged base unchanged', async () => {
    const { seen, rows } = await run();
    expect(seen[0]?.some((a) => a.startsWith('KARST_MERGED_BASE_SHA'))).toBe(false);
    expect(rows[0]?.summary).toBeNull();
  });
  it.each(['unit: 8 files, delta since abcdef123456', 'test:integration: 3 files, delta since abcdef123456', 'integration: 2 files, branch diff since abcdef123456'])(
    'keeps the vitest delta line %s',
    (line) => {
      expect(scopeLinesOf(`ok\n${line}\n1 passed`)).toBe(line);
    },
  );
  it('ignores a line that only looks like a vitest scope line', () => {
    expect(scopeLinesOf('unit: 8 files\nunit tests: 8 files, delta since x\nfoo unit: 8 files, delta')).toBeNull();
  });
  it('reads no scope line from plain output', () => {
    expect(scopeLinesOf('ok\n1 passed')).toBeNull();
  });
});
