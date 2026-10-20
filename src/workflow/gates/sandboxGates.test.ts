import { describe, expect, it, vi } from 'vitest';
import type { ProcessOutcome } from './run.js';
import { sandboxGateDeps } from './sandboxGates.js';

describe('sandboxGateDeps (arch:AC-32)', () => {
  it('is empty for a host ticket', () => {
    expect(sandboxGateDeps(undefined)).toEqual({});
  });

  it('routes the gate list and the verifier through the sandbox runner and disables the gate-skip', async () => {
    const gate = vi.fn(() => Promise.resolve<ProcessOutcome>({ kind: 'completed', exitCode: 1, output: '' }));
    const deps = sandboxGateDeps(gate);
    expect(deps.runVerifier).toBe(gate);
    await expect(deps.fingerprint!()).resolves.toBeNull();
    const out = await deps.runGates!([{ name: 'u', command: 'npm', args: ['test'], script: null, required: true }], '/wt');
    expect(gate).toHaveBeenCalledWith('npm', ['test'], '/wt', expect.any(Object));
    expect(out.results[0]!.exitCode).toBe(1);
    await deps.runGates!([], '/wt', { onDebug: () => undefined });
  });

  it('runs a sandbox:host gate on the host runner in declared order, inside gates in the sandbox (arch:AC-36)', async () => {
    const calls: string[] = [];
    const done = (tag: string) => (cmd: string) => { calls.push(`${tag}:${cmd}`); return Promise.resolve<ProcessOutcome>({ kind: 'completed', exitCode: 0, output: tag }); };
    const hostFactory = vi.fn(() => done('host'));
    const deps = sandboxGateDeps(done('in'), hostFactory);
    const g = (name: string, sandbox?: 'host') => ({ name, command: name, args: [], script: null, required: true, ...(sandbox ? { sandbox } : {}) });
    const out = await deps.runGates!([g('a'), g('b', 'host'), g('c')], '/wt');
    expect(calls).toEqual(['in:a', 'host:b', 'in:c']);
    expect(out.results.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(hostFactory).toHaveBeenCalledTimes(1);
    await deps.runGates!([g('a')], '/wt');
    expect(hostFactory).toHaveBeenCalledTimes(1);
  });
});
