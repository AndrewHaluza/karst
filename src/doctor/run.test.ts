import { describe, expect, it, vi } from 'vitest';
import { runDoctor, parseDoctorArea, renderDoctorText } from './run.js';
import type { FixEffects } from './applyFixes.js';
import type { DoctorCheck } from './types.js';

function effects(): FixEffects {
  return {
    markServerStopped: vi.fn(),
    pidStartedAtMs: vi.fn(() => 0),
    killProcess: vi.fn(),
    worktreeState: vi.fn(() => 'clean' as const),
    pruneWorktree: vi.fn(),
    quarantineOutbox: vi.fn(),
    recreateLauncher: vi.fn(),
  };
}
const dead: DoctorCheck = {
  id: 'state.server-dead.1', area: 'state', status: 'warn', detail: 'dead',
  fix: { tier: 'auto', summary: 'stop', action: { kind: 'mark-server-stopped', serverId: 1, pid: 9 } },
};
const consented: DoctorCheck = {
  id: 'tools.gh', area: 'tools', status: 'fail', detail: 'missing',
  fix: { tier: 'consented', summary: 'install', command: 'brew install gh' },
};

describe('runDoctor', () => {
  it('no flags: no effect runs', () => {
    const fx = effects();
    const r = runDoctor({ fix: false, collect: () => [dead, consented], effects: fx });
    for (const f of Object.values(fx)) expect(f).not.toHaveBeenCalled();
    expect(r.applied).toEqual([]);
    expect(r.exitCode).toBe(1);
  });
  it('--fix applies auto only, never consented, then re-collects', () => {
    const fx = effects();
    let n = 0;
    const collect = vi.fn(() => (n++ === 0 ? [dead, consented] : [consented]));
    const r = runDoctor({ fix: true, collect, effects: fx });
    expect(fx.markServerStopped).toHaveBeenCalledWith(1);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(r.applied).toHaveLength(1);
    expect(r.checks).toEqual([consented]);
  });
  it('exit 0 when nothing fails after fixes', () => {
    const r = runDoctor({ fix: true, collect: () => [], effects: effects() });
    expect(r.exitCode).toBe(0);
  });
  it('json shape', () => {
    const r = runDoctor({ areas: ['state'], fix: false, collect: () => [dead], effects: effects() });
    expect(Object.keys(r).sort()).toEqual(['applied', 'areas', 'checks', 'exitCode', 'fixRequested', 'summary']);
    expect(r.areas).toEqual(['state']);
    expect(r.summary).toEqual({ ok: 0, warn: 1, fail: 0 });
  });
  it('parses areas', () => {
    expect(parseDoctorArea('wiring')).toBe('wiring');
    expect(() => parseDoctorArea('x')).toThrow(/--area/);
  });
  it('renders text', () => {
    const r = runDoctor({ fix: false, collect: () => [dead, consented], effects: effects() });
    const t = renderDoctorText(r);
    expect(t).toContain('brew install gh');
    expect(t).toContain('1 warn, 1 fail'.replace('1 warn, 1 fail', '0 ok, 1 warn, 1 fail'));
  });
});
