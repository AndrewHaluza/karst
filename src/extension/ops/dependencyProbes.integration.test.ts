import { describe, expect, it } from 'vitest';
import { createDependencyProbes } from './dependencyProbes.js';
import { runProbeAsync, PROBE_OUTPUT_LIMIT, type ProbeRunner } from '../../runtime/depsAsync.js';

describe('dependency probes with a real child process', () => {
  it('gives up on a child that never exits and names the binary', async () => {
    const run: ProbeRunner = (_b, _a, env, capture) => runProbeAsync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], env, capture, 50);
    const faults = await createDependencyProbes({ run }).capabilityFaults('worktrees', 'claude');
    expect(faults.length).toBeGreaterThan(0);
    expect(faults.every((f) => f.timedOut === true)).toBe(true);
    expect(faults.map((f) => f.dep.binary)).toContain('git');
  });

  it('keeps at most PROBE_OUTPUT_LIMIT characters of stdout', async () => {
    const r = await runProbeAsync(
      process.execPath,
      ['-e', `process.stdout.write('x'.repeat(${PROBE_OUTPUT_LIMIT * 3}))`],
      undefined,
      true,
      10_000,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBe(PROBE_OUTPUT_LIMIT);
  });

  it('uses the live runner by default', async () => {
    await expect(createDependencyProbes().capabilityFaults('worktrees', 'claude')).resolves.toEqual([]);
  });
});
