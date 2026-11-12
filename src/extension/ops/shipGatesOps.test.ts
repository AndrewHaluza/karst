import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runShipGates } from './shipGatesOps.js';
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
    const r = await runShipGates([{ repo: 'io', number: 1, branch: 'b', cwd }], { uat: undefined, runProcess: exits(0) });
    expect(r).toMatch(/^io: cannot read package\.json/);
  });
  it('treats a gate that never started (no exit code) as no verdict, not a failure', async () => {
    const runProcess: GateProcessRunner = async () => ({ kind: 'spawnFailed', message: 'ENOENT' }) as never;
    expect(await runShipGates([repoWith({ test: 'x' })], { uat: undefined, runProcess })).toBeNull();
  });
  it('blocks when a host-only gate was refused by the host boundary (no verdict is not a pass)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-gates-'));
    const uat = { gates: [{ name: 'docs', kind: 'command', command: 'x', args: [], sandbox: 'host' }], repositories: {} } as never;
    const refuse: GateProcessRunner = async () => ({ kind: 'spawnFailed', message: 'no exec', output: 'refused' }) as never;
    const r = await runShipGates([{ repo: 'sb', number: 1, branch: 'b', cwd }], { uat, runProcess: refuse, hostProcess: refuse });
    expect(r).toBe('sb: gate "docs" could not run (refused by the host boundary), so the merge is not verified');
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

  it('records every gate also when the first gate fails, and keeps the failure summary', async () => {
    const { store, ticketId, pr } = setup();
    const out = await runShipGates([pr], { uat: twoGates, runProcess: byCommand({ u: 3 }), evidence: { store, ticketId }, headSha: async () => 'a'.repeat(40) });
    expect(out).toMatch(/gate "unit" failed \(exit 3\)/);
    const rows = listDeliverResults(store, ticketId);
    expect(rows.map((r) => [r.gateName, r.exitCode])).toEqual([['unit', 3], ['docs', 0]]);
    expect(rows[0]!.summary).toBe('boom: broke');
    expect(currentDeliverRun(store, ticketId)?.state).toBe('failed');
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
    const out = await runShipGates([pr], { uat: twoGates, runProcess, signal: ac.signal, evidence: { store, ticketId }, headSha: async () => 'a'.repeat(40) });
    expect(out).toMatch(/gate run was stopped/);
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
  it('runs the UI gates when the diff has a UI path', async () => {
    const { ran } = await run(gitDiff(['src/ui/a.tsx']));
    expect(ran).toEqual(names);
  });
  it('runs the UI gates when the diff is unreadable', async () => {
    const { ran } = await run(gitDiff([], true));
    expect(ran).toEqual(names);
  });
  it('runs the UI gates when no base ref is known', async () => {
    const pr = repoWith(scripts);
    const ran: string[] = [];
    const runProcess: GateProcessRunner = async (_cmd, args) => { ran.push(args.find((a) => names.includes(a)) ?? '?'); return { kind: 'completed', exitCode: 0, output: '' }; };
    await runShipGates([pr], { uat: uiGates, runProcess, git: gitDiff(['src/store/a.ts']) });
    expect(ran).toEqual(names);
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
    const out = await runShipGates([{ repo: 'r', number: 1, branch: 'b', cwd }], {
      uat, runProcess, evidence: { store, ticketId }, signal: ac.signal, onRunOpened: (id) => opened.push(id),
      headSha: async () => { ac.abort(); return 'd'.repeat(40); },
    });
    expect(out).not.toBeNull();
    expect(ran).toEqual([]);
    expect(opened).toEqual([]);
    expect(currentDeliverRun(store, ticketId)).toBeNull();
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
  const run = async (uiChanged: boolean) => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-9', title: 't' }).id;
    const ran: string[] = [];
    const runProcess: GateProcessRunner = async (_c, args) => { ran.push(args.find((a) => a === 'test' || a === 'test:visual:docker') ?? '?'); return { kind: 'completed', exitCode: 0, output: '' }; };
    // No git runner: the cut must come from the base delta, never from a diff of the merged tree against the base.
    await runShipGates([repoWith(scripts)], { uat, runProcess, uiChanged, kind: 'base-moved', evidence: { store, ticketId }, headSha: async () => 'd'.repeat(40) });
    return { ran, store, ticketId };
  };

  it('cuts the visual gate when the base delta holds no UI path, and records the cut', async () => {
    const { ran, store, ticketId } = await run(false);
    expect(ran).toEqual(['test']);
    expect(currentDeliverRun(store, ticketId)).toMatchObject({ kind: 'base-moved', headSha: 'd'.repeat(40), gates: ['unit', 'visual'] });
    expect(listDeliverResults(store, ticketId).find((r) => r.gateName === 'visual')).toMatchObject({ exitCode: null, summary: NO_UI_CHANGE_REASON });
  });
  it('runs the visual gate when the base delta holds a UI path', async () => {
    expect((await run(true)).ran).toEqual(['test', 'test:visual:docker']);
  });
});
