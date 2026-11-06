import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket, setStageCurrent } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { claimStallSuggestion, saveStallSuggestion } from '../../store/stallSuggestions.js';
import { makeStallActions, stallPlanningKickoff } from './stallActions.js';

const AT = '2026-01-02T00:00:00.000Z';
const suggestion = { cause: 'Likely a design gap.', options: [{ kind: 'agent' as const, label: 'Split', note: 'Split it.', recommended: true }] };

function setup() {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'ST-1', title: 't' }).id;
  setStageCurrent(store, ticketId, 'fix');
  setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'stalled', blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: AT });
  const deps = {
    store, ticketId, notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) },
    redrive: vi.fn(), refresh: vi.fn(), diffFiles: async () => null, maxRounds: () => 5, blockingSeverity: 'medium' as const,
    ensure: vi.fn(async () => {}), startPlanning: vi.fn(async () => {}),
  };
  return { store, ticketId, deps };
}

describe('stall actions', () => {
  it('kickoff carries the key and the suggestion', () => {
    const text = stallPlanningKickoff('ST-1', suggestion);
    expect(text).toContain('ST-1');
    expect(text).toContain('Likely a design gap.');
    expect(text).toContain('1. Split (recommended): Split it.');
    expect(stallPlanningKickoff('ST-1', null)).toContain('no written suggestion');
  });
  it('retry forces a new run', async () => {
    const { deps, ticketId } = setup();
    await makeStallActions(deps).stallRetry();
    expect(deps.ensure).toHaveBeenCalledWith(ticketId, { retry: true });
  });
  it('planning opens a session with the stored suggestion', async () => {
    const { deps, store, ticketId } = setup();
    claimStallSuggestion(store, ticketId, AT, AT);
    saveStallSuggestion(store, ticketId, AT, suggestion, AT);
    await makeStallActions(deps).stallPlanning();
    const [title, kickoff] = deps.startPlanning.mock.calls[0] as unknown as [string, string];
    expect(title).toContain('ST-1');
    expect(kickoff).toContain('Likely a design gap.');
  });
  it('planning still opens when the suggestion failed', async () => {
    const { deps } = setup();
    await makeStallActions(deps).stallPlanning();
    expect((deps.startPlanning.mock.calls[0] as unknown as [string, string])[1]).toContain('no written suggestion');
  });
  it('apply rejects with the refusal reason', async () => {
    const { deps, store, ticketId } = setup();
    setStageCurrent(store, ticketId, 'impl');
    await expect(makeStallActions(deps).stallApply({ kind: 'agent', label: 'x', note: 'n' })).rejects.toThrow();
  });
});
