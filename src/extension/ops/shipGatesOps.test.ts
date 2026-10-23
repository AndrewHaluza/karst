import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runShipGates } from './shipGatesOps.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';

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
});
