import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../store/db.js';
import type { GateProcessRunner } from '../workflow/gates/run.js';
import { bindGateRerunDeps, type GateRerunHost } from './gateRerunBinding.js';

const host = (over: Partial<GateRerunHost> = {}): GateRerunHost => ({
  store: openStore(':memory:'),
  manifest: () => undefined,
  runProcess: vi.fn() as unknown as GateProcessRunner,
  gateProcessFor: () => undefined,
  hostGateFor: () => undefined,
  onGateOutput: vi.fn(),
  onGateSpawned: vi.fn(),
  debug: vi.fn(),
  ...over,
});

describe('bindGateRerunDeps', () => {
  it('runs a host ticket on the host runner and a sandboxed ticket on its own runner', () => {
    const sandbox = vi.fn() as unknown as GateProcessRunner;
    const h = host({ gateProcessFor: (id) => (id === 2 ? sandbox : undefined) });
    const deps = bindGateRerunDeps(h);
    expect(deps.runnerFor(1)).toBe(h.runProcess);
    expect(deps.runnerFor(2)).toBe(sandbox);
    expect(deps.sandboxedFor?.(1)).toBe(false);
    expect(deps.sandboxedFor?.(2)).toBe(true);
  });

  it('takes a fresh host runner for a sandbox: host gate', () => {
    const fresh = vi.fn() as unknown as GateProcessRunner;
    const deps = bindGateRerunDeps(host({ hostGateFor: () => () => fresh }));
    expect(deps.hostGateFor?.(1)).toBe(fresh);
    expect(bindGateRerunDeps(host()).hostGateFor?.(1)).toBeUndefined();
  });

  it('has no base ref, no repo names and no regenerate spec without a manifest', () => {
    const deps = bindGateRerunDeps(host());
    expect(deps.baseRefFor?.(1, '/repo/web')).toBeUndefined();
    expect(deps.regenerateFor?.('web')).toBeUndefined();
  });

  it('forwards the live log and pid callbacks', () => {
    const h = host();
    const deps = bindGateRerunDeps(h);
    expect(deps.onGateOutput).toBe(h.onGateOutput);
    expect(deps.onGateSpawned).toBe(h.onGateSpawned);
  });
});
