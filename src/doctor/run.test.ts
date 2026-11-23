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
  it('no flags: no effect runs', async () => {
    const fx = effects();
    const r = await runDoctor({ fix: false, collect: () => [dead, consented], effects: fx });
    for (const f of Object.values(fx)) expect(f).not.toHaveBeenCalled();
    expect(r.applied).toEqual([]);
    expect(r.exitCode).toBe(1);
  });
  it('--fix applies auto only, never consented, then re-collects', async () => {
    const fx = effects();
    let n = 0;
    const collect = vi.fn(() => (n++ === 0 ? [dead, consented] : [consented]));
    const r = await runDoctor({ fix: true, collect, effects: fx });
    expect(fx.markServerStopped).toHaveBeenCalledWith(1);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(r.applied).toHaveLength(1);
    expect(r.checks).toEqual([consented]);
  });
  it('exit 0 when nothing fails after fixes', async () => {
    const r = await runDoctor({ fix: true, collect: () => [], effects: effects() });
    expect(r.exitCode).toBe(0);
  });
  it('json shape', async () => {
    const r = await runDoctor({ areas: ['state'], fix: false, collect: () => [dead], effects: effects() });
    expect(Object.keys(r).sort()).toEqual(['applied', 'areas', 'checks', 'exitCode', 'fixRequested', 'summary']);
    expect(r.areas).toEqual(['state']);
    expect(r.summary).toEqual({ ok: 0, warn: 1, fail: 0, skipped: 0 });
  });
  it('parses areas', async () => {
    expect(parseDoctorArea('wiring')).toBe('wiring');
    expect(() => parseDoctorArea('x')).toThrow(/--area/);
  });
  it('renders text', async () => {
    const r = await runDoctor({ fix: false, collect: () => [dead, consented], effects: effects() });
    const t = renderDoctorText(r);
    expect(t).toContain('brew install gh');
    expect(t).toContain('1 warn, 1 fail'.replace('1 warn, 1 fail', '0 ok, 1 warn, 1 fail'));
  });
});

const leaked: DoctorCheck = {
  id: 'state.server-leaked.2', area: 'state', status: 'warn', detail: 'leaked',
  fix: { tier: 'auto', summary: 'kill', action: { kind: 'kill-process', serverId: 2, pid: 9, startedAt: '2026-10-09 12:00:00' } },
};

describe('runDoctor --only', () => {
  it('applies only the listed auto fixes, and never the unlisted one', async () => {
    const fx = effects();
    let n = 0;
    const collect = vi.fn(() => (n++ === 0 ? [dead, leaked] : []));
    const r = await runDoctor({ fix: true, only: ['state.server-dead.1'], collect, effects: fx });

    expect(fx.markServerStopped).toHaveBeenCalledWith(1);
    expect(fx.killProcess).not.toHaveBeenCalled();
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0]).toMatchObject({ checkId: 'state.server-dead.1', ok: true });
  });

  it('reports a listed id that has no auto fix as skipped, with the exact entry', async () => {
    const fx = effects();
    const r = await runDoctor({
      fix: true,
      only: ['state.server-gone.9'],
      collect: () => [dead],
      effects: fx,
    });
    expect(fx.markServerStopped).not.toHaveBeenCalled();
    expect(r.applied).toContainEqual({
      checkId: 'state.server-gone.9',
      what: 'skipped state.server-gone.9',
      why: 'the problem is gone',
      evidence: 'not found when the fix ran',
      ok: false,
    });
  });

  it('reports a listed id whose fix is not auto as skipped', async () => {
    const r = await runDoctor({ fix: true, only: ['tools.gh'], collect: () => [consented], effects: effects() });
    expect(r.applied).toEqual([
      {
        checkId: 'tools.gh',
        what: 'skipped tools.gh',
        why: 'the problem is gone',
        evidence: 'not found when the fix ran',
        ok: false,
      },
    ]);
  });

  it('without only, every auto fix is applied (unchanged)', async () => {
    const fx = effects();
    const r = await runDoctor({ fix: true, collect: () => [dead, leaked], effects: fx });
    expect(fx.markServerStopped).toHaveBeenCalledWith(1);
    expect(r.applied.every((a) => a.ok)).toBe(true);
  });
});

describe('runDoctor skipped status', () => {
  const skipped: DoctorCheck = { id: 'state.worktree-prune.T-1.api', area: 'state', status: 'skipped', detail: 'cannot answer' };

  it('counts skipped separately and never fails the run', async () => {
    const r = await runDoctor({ fix: false, collect: () => [skipped, dead], effects: effects() });
    expect(r.summary).toEqual({ ok: 0, warn: 1, fail: 0, skipped: 1 });
    expect(r.exitCode).toBe(0);
  });

  it('renders [skip] and the skipped count when there is one', async () => {
    const r = await runDoctor({ fix: false, collect: () => [skipped], effects: effects() });
    const t = renderDoctorText(r);
    expect(t).toContain('[skip] state.worktree-prune.T-1.api');
    expect(t).toContain('0 ok, 0 warn, 0 fail, 1 skipped');
  });

  it('omits the skipped count from the summary line when zero', async () => {
    const r = await runDoctor({ fix: false, collect: () => [dead], effects: effects() });
    expect(renderDoctorText(r)).not.toContain('skipped');
  });
});

