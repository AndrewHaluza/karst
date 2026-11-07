import { describe, expect, it } from 'vitest';
import { openStore } from './db.js';
import { claimStallSuggestion, failStallSuggestion, getStallSuggestion, saveStallSuggestion, STALL_GENERATING_STALE_MS } from './stallSuggestions.js';
import { createTicket } from './tickets.js';

const T0 = '2026-01-01T00:00:00.000Z';
const sug = { cause: 'c', options: [{ kind: 'agent' as const, label: 'a', note: 'n', recommended: true }] };

function setup() {
  const store = openStore(':memory:');
  const id = createTicket(store, { key: 'K', title: 't' }).id;
  return { store, id };
}

describe('stall suggestions store', () => {
  it('claims once, saves and reads back', () => {
    const { store, id } = setup();
    expect(getStallSuggestion(store, id, 'p1')).toBeNull();
    expect(claimStallSuggestion(store, id, 'p1', T0)).toBe(true);
    expect(claimStallSuggestion(store, id, 'p1', T0)).toBe(false);
    expect(getStallSuggestion(store, id, 'p1')?.status).toBe('generating');
    saveStallSuggestion(store, id, 'p1', sug, T0);
    expect(getStallSuggestion(store, id, 'p1')).toMatchObject({ status: 'ready', suggestion: sug });
    expect(claimStallSuggestion(store, id, 'p1', T0, true)).toBe(false);
  });
  it('keeps a row per park', () => {
    const { store, id } = setup();
    claimStallSuggestion(store, id, 'p1', T0);
    expect(getStallSuggestion(store, id, 'p2')).toBeNull();
  });
  it('retries only a failed row', () => {
    const { store, id } = setup();
    claimStallSuggestion(store, id, 'p1', T0);
    failStallSuggestion(store, id, 'p1', 'usage limit', true, T0);
    expect(getStallSuggestion(store, id, 'p1')).toMatchObject({ status: 'failed', error: 'usage limit', usageLimit: true });
    expect(claimStallSuggestion(store, id, 'p1', T0)).toBe(false);
    expect(claimStallSuggestion(store, id, 'p1', T0, true)).toBe(true);
    expect(getStallSuggestion(store, id, 'p1')?.status).toBe('generating');
  });
  it('takes over a stale generating row', () => {
    const { store, id } = setup();
    claimStallSuggestion(store, id, 'p1', T0);
    const later = new Date(Date.parse(T0) + STALL_GENERATING_STALE_MS + 1).toISOString();
    expect(claimStallSuggestion(store, id, 'p1', later)).toBe(true);
  });
  it('reads a corrupt ready row as failed', () => {
    const { store, id } = setup();
    claimStallSuggestion(store, id, 'p1', T0);
    store.db.prepare("UPDATE review_stall_suggestions SET status='ready', suggestion='{x'").run();
    expect(getStallSuggestion(store, id, 'p1')?.status).toBe('failed');
  });
});
