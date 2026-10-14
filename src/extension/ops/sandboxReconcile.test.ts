import { describe, expect, it, vi } from 'vitest';
import { runSandboxReconcile } from './bootSweeps.js';

const box = (ticketId: number, state: 'running' | 'stopped') =>
  ({ runner: 'sbx' as const, name: `karst-ab12cd34-${ticketId}-claude`, ticketId, core: 'claude', state });

describe('runSandboxReconcile', () => {
  it('logs running/stopped/missing/orphans and drops a missing sandbox session', async () => {
    const info = vi.fn(), clearSession = vi.fn();
    const r = await runSandboxReconcile({
      inventory: async () => ({ sandboxes: [box(1, 'running'), box(2, 'stopped'), box(9, 'running')], errors: ['docker ps failed: x'] }),
      live: () => [1, 2, 3].map((id) => ({ id, sessionId: `s${id}`, sessionProvider: 'claude' })),
      owns: () => true, clearSession, info, logError: vi.fn(),
    });
    expect(r).toEqual({ running: [1], stopped: [2], missing: [3], orphans: [box(9, 'running')] });
    expect(clearSession).toHaveBeenCalledWith(3);
    expect(info.mock.calls.map((c) => c[0])).toEqual([
      'karst: sandbox listing: docker ps failed: x',
      'karst: sandbox(es) running for ticket(s) 1: reattached on open',
      'karst: sandbox(es) stopped for ticket(s) 2: restarted on open',
      'karst: sandbox(es) missing for ticket(s) 3: next open starts a fresh session',
      expect.stringContaining('karst: sandbox karst-ab12cd34-9-claude belongs to ticket 9, which is not live — run'),
    ]);
  });
  it('quiet when nothing; never throws', async () => {
    const info = vi.fn(), logError = vi.fn();
    const base = { live: () => [], owns: () => true, clearSession: vi.fn(), info, logError };
    await runSandboxReconcile({ ...base, inventory: async () => ({ sandboxes: [], errors: [] }) });
    expect(info).not.toHaveBeenCalled();
    await expect(runSandboxReconcile({ ...base, inventory: async () => { throw new Error('boom'); } })).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith('karst: sandbox reconcile failed', expect.any(Error));
  });
});
