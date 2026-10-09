import { describe, expect, it, vi } from 'vitest';
import { applyFixes, parseDbTimeMs, type FixEffects } from './applyFixes.js';
import type { DoctorCheck } from './types.js';

function fx(over: Partial<FixEffects> = {}): FixEffects {
  return {
    markServerStopped: vi.fn(), pidStartedAtMs: vi.fn(() => Date.parse('2026-01-01T00:00:00Z')),
    killProcess: vi.fn(), worktreeState: vi.fn(() => 'clean' as const), pruneWorktree: vi.fn(),
    quarantineOutbox: vi.fn(), recreateLauncher: vi.fn(), ...over,
  };
}
const auto = (action: DoctorCheck['fix'] & { tier: 'auto' } extends infer F ? (F extends { action: infer A } ? A : never) : never): DoctorCheck => ({
  id: 'x', area: 'state', status: 'warn', detail: '', fix: { tier: 'auto', summary: 's', action },
});
const kill = auto({ kind: 'kill-process', serverId: 1, pid: 5, startedAt: '2026-01-01 00:00:00' });

describe('applyFixes', () => {
  it('parses sqlite UTC times', () => {
    expect(parseDbTimeMs('2026-01-01 00:00:00')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(parseDbTimeMs('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });
  it('kills when start time matches', () => {
    const e = fx();
    expect(applyFixes([kill], e)[0]!.ok).toBe(true);
    expect(e.killProcess).toHaveBeenCalledWith(5);
  });
  it('does not kill a reused pid (started later)', () => {
    const e = fx({ pidStartedAtMs: vi.fn(() => Date.parse('2026-01-02T00:00:00Z')) });
    expect(applyFixes([kill], e)[0]!.ok).toBe(false);
    expect(e.killProcess).not.toHaveBeenCalled();
  });
  it('does not kill when start time unknown', () => {
    const e = fx({ pidStartedAtMs: vi.fn(() => undefined) });
    applyFixes([kill], e);
    expect(e.killProcess).not.toHaveBeenCalled();
  });
  const prune = auto({ kind: 'prune-worktree', ticketId: 1, repo: 'r', path: '/w', branch: 'b' });
  it('prunes a clean worktree', () => {
    const e = fx();
    expect(applyFixes([prune], e)[0]!.ok).toBe(true);
    expect(e.pruneWorktree).toHaveBeenCalled();
  });
  it('does not prune a dirty worktree', () => {
    const e = fx({ worktreeState: vi.fn(() => 'dirty' as const) });
    expect(applyFixes([prune], e)[0]!.ok).toBe(false);
    expect(e.pruneWorktree).not.toHaveBeenCalled();
  });
  it('runs outbox/launcher/stop and survives a throwing fix', () => {
    const e = fx({ quarantineOutbox: vi.fn(() => { throw new Error('boom'); }) });
    const out = applyFixes([auto({ kind: 'quarantine-outbox', path: '/o' }), auto({ kind: 'recreate-launcher' }), auto({ kind: 'mark-server-stopped', serverId: 2, pid: null })], e);
    expect(out.map((o) => o.ok)).toEqual([false, true, true]);
    expect(out[0]!.evidence).toBe('boom');
  });
  it('ignores consented and report fixes', () => {
    const e = fx();
    const c: DoctorCheck[] = [
      { id: 'a', area: 'tools', status: 'fail', detail: '', fix: { tier: 'consented', summary: '', command: 'x' } },
      { id: 'b', area: 'tools', status: 'fail', detail: '', fix: { tier: 'report', summary: '', nextStep: 'y' } },
    ];
    expect(applyFixes(c, e)).toEqual([]);
  });
});
