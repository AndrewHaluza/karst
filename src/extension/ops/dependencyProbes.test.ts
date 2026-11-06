import { describe, expect, it, vi } from 'vitest';
import { createDependencyProbes } from './dependencyProbes.js';
import { createCapabilityGuard, describeFaults } from './capabilityGuard.js';
import { GIT_DEPENDENCY, NPM_DEPENDENCY, type DependencyFault } from '../../runtime/deps.js';
import { type ProbeRunner } from '../../runtime/depsAsync.js';

const ok: ProbeRunner = async () => ({ stdout: '', exitCode: 0, timedOut: false });

describe('dependency probes', () => {
  it('reports a timed-out probe as a fault that names the binary, and the host continues', async () => {
    const hung: ProbeRunner = () => new Promise((r) => setTimeout(() => r({ stdout: '', exitCode: 1, timedOut: true }), 20));
    const probes = createDependencyProbes({ run: hung });
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

  it('isCapabilityKnownBlocked is false cold, true after a fault, false after a clean probe', async () => {
    const bad: ProbeRunner = async () => ({ stdout: '', exitCode: 1, timedOut: false });
    const badProbes = createDependencyProbes({ run: bad });
    expect(badProbes.isCapabilityKnownBlocked('worktrees', 'claude')).toBe(false);
    await badProbes.capabilityFaults('worktrees', 'claude');
    expect(badProbes.isCapabilityKnownBlocked('worktrees', 'claude')).toBe(true);
    const good = createDependencyProbes({ run: ok });
    await good.capabilityFaults('worktrees', 'claude');
    expect(good.isCapabilityKnownBlocked('worktrees', 'claude')).toBe(false);
  });
});

describe('dependency probes, window edges', () => {
  it('expires a result exactly at the window end, not before', async () => {
    let t = 5_000;
    const run = vi.fn(ok);
    const probes = createDependencyProbes({ run, now: () => t, ttlMs: 1_000 });
    await probes.capabilityFaults('worktrees', 'claude');
    const first = run.mock.calls.length;
    t = 5_999;
    await probes.capabilityFaults('worktrees', 'claude');
    expect(run).toHaveBeenCalledTimes(first);
    t = 6_000;
    await probes.capabilityFaults('worktrees', 'claude');
    expect(run).toHaveBeenCalledTimes(first * 2);
  });

  it('does not report a stale fault as blocked and probes again', async () => {
    let t = 5_000;
    const run = vi.fn<ProbeRunner>(async () => ({ stdout: '', exitCode: 1, timedOut: false }));
    const probes = createDependencyProbes({ run, now: () => t, ttlMs: 1_000 });
    await probes.capabilityFaults('worktrees', 'claude');
    const first = run.mock.calls.length;
    t = 6_000;
    expect(probes.isCapabilityKnownBlocked('worktrees', 'claude')).toBe(false);
    expect(run.mock.calls.length).toBeGreaterThan(first);
  });

  it('lists the faults of the whole registry', async () => {
    const run: ProbeRunner = async () => ({ stdout: '', exitCode: 1, timedOut: true });
    const faults = await createDependencyProbes({ run }).faults('claude');
    expect(faults.map((f) => f.dep.binary)).toEqual(expect.arrayContaining(['git', 'npm', 'gh']));
  });
});

describe('dependency probes, keys and defaults', () => {
  it('caches each dependency on its own key', async () => {
    const run = vi.fn(ok);
    const probes = createDependencyProbes({ run });
    await probes.capabilityFaults('worktrees', 'claude');
    await probes.capabilityFaults('ship', 'claude');
    expect(run.mock.calls.some(([binary]) => binary === 'git')).toBe(true);
    expect(run.mock.calls.some(([binary]) => binary === 'gh')).toBe(true);
  });
});

describe('describeFaults', () => {
  const missing = (dep: typeof GIT_DEPENDENCY): DependencyFault => ({ dep, state: 'missing' });

  it('joins the message of each fault with one space', () => {
    const text = describeFaults([missing(GIT_DEPENDENCY), missing(NPM_DEPENDENCY)]);
    expect(text).toContain(`${GIT_DEPENDENCY.install} Karst can't`);
  });

  it('names the binary for a timeout and does not for a plain fault', () => {
    const timed = describeFaults([{ dep: GIT_DEPENDENCY, state: 'not-ready', timedOut: true }]);
    expect(timed).toContain("'git' did not answer in time");
    expect(describeFaults([missing(GIT_DEPENDENCY)])).not.toContain('did not answer');
  });

  it('skips a state with no message', () => {
    const none = { dep: GIT_DEPENDENCY, state: 'ok' } as unknown as DependencyFault;
    expect(describeFaults([none, missing(GIT_DEPENDENCY)])).toBe(describeFaults([missing(GIT_DEPENDENCY)]));
  });
});

describe('capability guard', () => {
  const build = (run: ProbeRunner) => {
    const showError = vi.fn(async () => false);
    const warn = vi.fn();
    const onBlocked = vi.fn();
    const guard = createCapabilityGuard({
      probes: createDependencyProbes({ run }),
      providerFor: () => 'claude',
      onBlocked,
      warn,
      showError,
      openChecklist: vi.fn(),
    });
    return { guard, showError, warn, onBlocked };
  };

  it('blocks the action on a timed-out probe and names the binary in the message', async () => {
    const { guard, showError } = build(async () => ({ stdout: '', exitCode: 1, timedOut: true }));
    expect(await guard('worktrees')).toBe(false);
    expect(showError).toHaveBeenCalledWith(expect.stringContaining("'git' did not answer in time"));
  });

  it('repaints the status bar and logs which binary blocked and why', async () => {
    const { guard, warn, onBlocked } = build(async () => ({ stdout: '', exitCode: 1, timedOut: true }));
    await guard('worktrees');
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("blocked: 'git' is not answering");
  });

  it('opens the setup checklist only when the user asks for it', async () => {
    const fail: ProbeRunner = async () => ({ stdout: '', exitCode: 1, timedOut: false });
    for (const choice of [true, false]) {
      const openChecklist = vi.fn();
      const guard = createCapabilityGuard({
        probes: createDependencyProbes({ run: fail }),
        providerFor: () => 'claude',
        onBlocked: vi.fn(),
        warn: vi.fn(),
        showError: async () => choice,
        openChecklist,
      });
      await guard('worktrees');
      await new Promise((r) => setImmediate(r));
      expect(openChecklist).toHaveBeenCalledTimes(choice ? 1 : 0);
    }
  });

  it('sync view allows on a cold cache and refuses only after a fault is found', async () => {
    const fail: ProbeRunner = async () => ({ stdout: '', exitCode: 1, timedOut: false });
    const { guard } = build(fail);
    expect(guard.known('worktrees')).toBe(true);
    await guard('worktrees', undefined, true);
    expect(guard.known('worktrees')).toBe(false);
  });

  it('sync view stays allowed after a clean probe', async () => {
    const { guard } = build(ok);
    await guard('worktrees', undefined, true);
    expect(guard.known('worktrees')).toBe(true);
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
