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
});
