import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, setStageCurrent } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { claimStallSuggestion, getStallSuggestion } from '../store/stallSuggestions.js';
import { createStallBinding } from './stallBinding.js';

function make(processFor: () => never | null = () => null) {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'S', title: 's' }).id;
  const startPlanning = vi.fn(async () => undefined);
  const refresh = vi.fn();
  const git = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 }));
  const binding = createStallBinding({ store, git, manifest: () => undefined, processFor, refresh, startPlanning, debug: vi.fn() });
  return { binding, ticketId, startPlanning, git, store };
}

describe('createStallBinding', () => {
  it('reads the blocking severity from the defaults when no manifest is loaded', () => {
    const { binding, ticketId } = make();
    expect(binding.hostFor(ticketId).blockingSeverity()).toBe('high');
  });
  it.each([{}, { review: {} }, { review: { findings: {} } }])('falls back to the default for the manifest %j', (manifest) => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'S', title: 's' }).id;
    const binding = createStallBinding({ store, git: vi.fn(), manifest: () => manifest as never, processFor: () => null, refresh: vi.fn(), startPlanning: vi.fn(), debug: vi.fn() });
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
  it('records a failed row when the stall-suggestion process is off', async () => {
    const { binding, ticketId, store } = make();
    setStageCurrent(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: 'P1' });
    await binding.service.ensure(ticketId);
    const row = getStallSuggestion(store, ticketId, 'P1');
    expect(row?.status).toBe('failed');
    expect(row).toMatchObject({ status: 'failed', usageLimit: false, error: 'The stall suggestion process is off. Turn it on in Settings, then press Retry.' });
  });
  it('records the process-off reason even when the ticket has a worktree', async () => {
    const { binding, ticketId, store } = make();
    store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode, created_at) VALUES (?, 'r', '/w', 'b', 'develop', 'none', 'x')").run(ticketId);
    setStageCurrent(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: 'P1' });
    await binding.service.ensure(ticketId);
    expect(getStallSuggestion(store, ticketId, 'P1')).toMatchObject({ status: 'failed', error: expect.stringContaining('process is off') });
  });
  it('leaves a live generating row of another window alone', async () => {
    const { binding, ticketId, store } = make();
    setStageCurrent(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: 'P1' });
    claimStallSuggestion(store, ticketId, 'P1', new Date().toISOString());
    await binding.service.ensure(ticketId, { retry: true });
    expect(getStallSuggestion(store, ticketId, 'P1')?.status).toBe('generating');
  });
  it('runs the agent in the first worktree when the process is on', async () => {
    const raw = JSON.stringify({ cause: 'Likely a gap.', options: [{ label: 'Split', note: 'Split it.', recommended: true }] });
    const runHeadless = vi.fn(async (_call: { cwd?: string }) => ({ raw }));
    const { binding, ticketId, store } = make(() => ({ adapter: { runHeadless }, assignment: {} }) as never);
    store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode, created_at) VALUES (?, 'r', '/w', 'b', 'develop', 'none', 'x')").run(ticketId);
    setStageCurrent(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: 'P1' });
    await binding.service.ensure(ticketId);
    expect(runHeadless).toHaveBeenCalledTimes(1);
    expect(runHeadless.mock.calls[0]![0].cwd).toBe('/w');
    expect(getStallSuggestion(store, ticketId, 'P1')?.status).toBe('ready');
  });
  it('records a failed row when the ticket has no worktree', async () => {
    const { binding, ticketId, store } = make(() => ({ adapter: {} as never, assignment: {} as never }) as never);
    setStageCurrent(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: 'P1' });
    await binding.service.ensure(ticketId);
    const row = getStallSuggestion(store, ticketId, 'P1');
    expect(row).toMatchObject({ status: 'failed', usageLimit: false, error: 'The ticket has no worktree, so the agent has no place to read the code.' });
  });
  it('ensure is a no-op for a ticket that is not stalled', async () => {
    const { binding, ticketId } = make();
    await expect(binding.hostFor(ticketId).ensure(ticketId)).resolves.toBeUndefined();
  });
});
