import { describe, expect, it, vi } from 'vitest';
import type { ProjectSandbox } from './sandboxInventory.js';
import { pickTicketSandbox } from './sandboxLookup.js';

const box = (ticketId: number, core: string, extra: Partial<ProjectSandbox> = {}): ProjectSandbox => ({
  runner: core === 'claude' || core === 'codex' ? 'sbx' : 'docker', name: `karst-ab12cd34-${ticketId}-${core}`, ticketId, core, state: 'running', ...extra,
});

describe('pickTicketSandbox', () => {
  it('finds the sandbox with a null hint (sessionProvider empty)', () => {
    expect(pickTicketSandbox([box(7, 'opencode2'), box(8, 'claude')], 7, null)?.core).toBe('opencode2');
  });
  it('returns undefined when the ticket has none', () => {
    expect(pickTicketSandbox([box(8, 'claude')], 7, 'claude')).toBeUndefined();
    expect(pickTicketSandbox([], 7, null)).toBeUndefined();
  });
  it('ignores invalid-core objects', () => {
    expect(pickTicketSandbox([box(7, 'null', { invalidCore: true })], 7, null)).toBeUndefined();
  });
  it('with two, takes the one matching the hint, else the last, and warns', () => {
    const warn = vi.fn();
    const two = [box(7, 'claude'), box(7, 'opencode')];
    expect(pickTicketSandbox(two, 7, 'claude', warn)?.core).toBe('claude');
    expect(pickTicketSandbox(two, 7, null, warn)?.core).toBe('opencode');
    expect(pickTicketSandbox(two, 7, 'codex', warn)?.core).toBe('opencode');
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]![0]).toContain('has 2 sandboxes');
  });
});
