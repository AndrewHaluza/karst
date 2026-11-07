import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { createStallBinding } from './stallBinding.js';

function make(processFor: () => null = () => null) {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'S', title: 's' }).id;
  const startPlanning = vi.fn(async () => undefined);
  const refresh = vi.fn();
  const git = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 }));
  const binding = createStallBinding({ store, git, manifest: () => undefined, processFor, refresh, startPlanning, debug: vi.fn() });
  return { binding, ticketId, startPlanning, git };
}

describe('createStallBinding', () => {
  it('reads the blocking severity from the defaults when no manifest is loaded', () => {
    const { binding, ticketId } = make();
    expect(binding.hostFor(ticketId).blockingSeverity()).toBe('high');
  });
  it('prefers the manifest blocking severity', () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'S', title: 's' }).id;
    const manifest = { review: { findings: { blockingSeverity: 'low' } } } as never;
    const binding = createStallBinding({ store, git: vi.fn(), manifest: () => manifest, processFor: () => null, refresh: vi.fn(), startPlanning: vi.fn(), debug: vi.fn() });
    expect(binding.hostFor(ticketId).blockingSeverity()).toBe('low');
  });
  it('reads no diff when the ticket has no worktree', async () => {
    const { binding, ticketId, git } = make();
    expect(await binding.hostFor(ticketId).diffFiles()).toBeNull();
    expect(git).not.toHaveBeenCalled();
  });
  it('hands planning the title and the first message', async () => {
    const { binding, ticketId, startPlanning } = make();
    await binding.hostFor(ticketId).startPlanning('T', 'K');
    expect(startPlanning).toHaveBeenCalledWith('T', 'K');
  });
  it('ensure is a no-op for a ticket that is not stalled', async () => {
    const { binding, ticketId } = make();
    await expect(binding.hostFor(ticketId).ensure(ticketId)).resolves.toBeUndefined();
  });
});
