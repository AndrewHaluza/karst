import { describe, expect, it, vi } from 'vitest';
import { createDependencyProbes } from './dependencyProbes.js';
import { createCapabilityGuard } from './capabilityGuard.js';
import { runProbeAsync, type ProbeRunner } from '../../runtime/depsAsync.js';

const ok: ProbeRunner = async () => ({ stdout: '', exitCode: 0, timedOut: false });

describe('dependency probes', () => {
  it('reports a probe that never exits as a fault that names the binary, and the host continues', async () => {
    // A real child that never exits: the probe must give up on its own timer.
    const hung: ProbeRunner = (binary, args, env, capture) =>
      runProbeAsync(binary, args, env, capture, 50);
    const probes = createDependencyProbes({ run: (_b, a, e, c) => hung('sleep', ['30'], e, c) });
    let hostContinued = false;
    setImmediate(() => { hostContinued = true; });
    const faults = await probes.capabilityFaults('worktrees', 'claude');
    expect(hostContinued).toBe(true);
    expect(faults.length).toBeGreaterThan(0);
    expect(faults.every((f) => f.timedOut === true)).toBe(true);
    expect(faults.map((f) => f.dep.binary)).toContain('git');
  });

  it('runs one probe for two guards inside the cache window, and a re-check runs a new one', async () => {
    let t = 0;
    const run = vi.fn(ok);
    const probes = createDependencyProbes({ run, now: () => t });
    await probes.capabilityFaults('worktrees', 'claude');
    const first = run.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    t = 59_000;
    await probes.capabilityFaults('worktrees', 'claude');
    expect(run).toHaveBeenCalledTimes(first);
    probes.clear();
    await probes.capabilityFaults('worktrees', 'claude');
    expect(run).toHaveBeenCalledTimes(first * 2);
    t = 200_000;
    await probes.capabilityFaults('worktrees', 'claude');
    expect(run).toHaveBeenCalledTimes(first * 3);
  });

  it('treats a missing binary as missing, not timed out', async () => {
    const run: ProbeRunner = async () => ({ stdout: '', exitCode: 1, timedOut: false });
    const faults = await createDependencyProbes({ run }).capabilityFaults('worktrees', 'claude');
    expect(faults.every((f) => f.state === 'missing' && !f.timedOut)).toBe(true);
  });

  it('knownCapabilityFaults never blocks and reports a settled fault', async () => {
    const run: ProbeRunner = async () => ({ stdout: '', exitCode: 1, timedOut: false });
    const probes = createDependencyProbes({ run });
    expect(probes.knownCapabilityFaults('worktrees', 'claude')).toEqual([]);
    await probes.capabilityFaults('worktrees', 'claude');
    expect(probes.knownCapabilityFaults('worktrees', 'claude').length).toBeGreaterThan(0);
  });
});

describe('capability guard', () => {
  const build = (run: ProbeRunner) => {
    const showError = vi.fn(async () => false);
    const warn = vi.fn();
    const guard = createCapabilityGuard({
      probes: createDependencyProbes({ run }),
      providerFor: () => 'claude',
      onBlocked: vi.fn(),
      warn,
      showError,
      openChecklist: vi.fn(),
    });
    return { guard, showError, warn };
  };

  it('blocks the action on a timed-out probe and names the binary in the message', async () => {
    const { guard, showError } = build(async () => ({ stdout: '', exitCode: 1, timedOut: true }));
    expect(await guard('worktrees')).toBe(false);
    expect(showError).toHaveBeenCalledWith(expect.stringContaining("'git' did not answer in time"));
  });

  it('allows the action when every probe passes', async () => {
    const { guard, showError } = build(ok);
    expect(await guard('worktrees')).toBe(true);
    expect(showError).not.toHaveBeenCalled();
  });

  it('stays silent on request but still blocks', async () => {
    const { guard, showError } = build(async () => ({ stdout: '', exitCode: 1, timedOut: false }));
    expect(await guard('worktrees', undefined, true)).toBe(false);
    expect(showError).not.toHaveBeenCalled();
  });
});
