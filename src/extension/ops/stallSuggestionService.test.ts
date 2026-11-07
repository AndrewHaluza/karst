import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket, setStageCurrent } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { getStallSuggestion, saveStallSuggestion, claimStallSuggestion, failStallSuggestion } from '../../store/stallSuggestions.js';
import { createStallSuggestionService } from './stallSuggestionService.js';

const AT = '2026-01-01T00:00:00.000Z';

function setup(stalled = true) {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'S', title: 's' }).id;
  if (stalled) {
    setStageCurrent(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: AT });
  }
  const generate = vi.fn(async () => 'ready' as const);
  const readDiff = vi.fn(async () => ({ files: ['docs/a.md'], stat: 's' }));
  const refresh = vi.fn();
  const svc = createStallSuggestionService({ store, readDiff, generate, refresh });
  return { store, ticketId, generate, readDiff, refresh, svc };
}

describe('stall suggestion service', () => {
  it('generates once for a stalled ticket and repaints', async () => {
    const { ticketId, generate, refresh, svc } = setup();
    await svc.ensure(ticketId);
    expect(generate).toHaveBeenCalledWith(ticketId, AT, { files: ['docs/a.md'], stat: 's' }, false);
    expect(refresh).toHaveBeenCalledWith(ticketId);
  });
  it('does nothing for a ticket that is not stalled', async () => {
    const { ticketId, generate, svc } = setup(false);
    await svc.ensure(ticketId);
    expect(generate).not.toHaveBeenCalled();
  });
  it('does not start a second run while one is in flight', async () => {
    const { ticketId, generate, svc } = setup();
    await Promise.all([svc.ensure(ticketId), svc.ensure(ticketId)]);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('skips a park that already has a ready or failed row, unless Retry', async () => {
    const { store, ticketId, generate, svc } = setup();
    claimStallSuggestion(store, ticketId, AT, AT);
    failStallSuggestion(store, ticketId, AT, 'x', false, AT);
    await svc.ensure(ticketId);
    expect(generate).not.toHaveBeenCalled();
    await svc.ensure(ticketId, { retry: true });
    expect(generate).toHaveBeenCalledWith(ticketId, AT, expect.anything(), true);
  });
  it('skips a ready row', async () => {
    const { store, ticketId, generate, svc } = setup();
    claimStallSuggestion(store, ticketId, AT, AT);
    saveStallSuggestion(store, ticketId, AT, { cause: 'c', options: [] }, AT);
    await svc.ensure(ticketId);
    expect(generate).not.toHaveBeenCalled();
  });
  it('uses an empty diff when the diff cannot be read', async () => {
    const { ticketId, generate, readDiff, svc } = setup();
    readDiff.mockResolvedValueOnce(null as never);
    await svc.ensure(ticketId);
    expect(generate).toHaveBeenCalledWith(ticketId, AT, { files: [], stat: '' }, false);
  });
  it('frees the slot after a thrown error and does not reject', async () => {
    const { ticketId, generate, svc } = setup();
    generate.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.ensure(ticketId)).resolves.toBeUndefined();
    await svc.ensure(ticketId, { retry: true });
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('records a failed row when generation throws before a row exists, so the panel never waits forever', async () => {
    const { store, ticketId, generate, svc } = setup();
    generate.mockRejectedValueOnce(new Error('no adapter'));
    await svc.ensure(ticketId);
    expect(getStallSuggestion(store, ticketId, AT)).toMatchObject({ status: 'failed', usageLimit: false });
  });
  it('keeps a ready row when a later step throws', async () => {
    const { store, ticketId, generate, svc } = setup();
    generate.mockImplementationOnce(async () => {
      claimStallSuggestion(store, ticketId, AT, AT);
      saveStallSuggestion(store, ticketId, AT, { cause: 'c', options: [] }, AT);
      throw new Error('late');
    });
    await svc.ensure(ticketId);
    expect(getStallSuggestion(store, ticketId, AT)?.status).toBe('ready');
  });
});
