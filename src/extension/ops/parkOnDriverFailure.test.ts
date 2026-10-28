import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import { getStage } from '../../store/stages.js';
import { parkGateOnDriverFailure } from './parkOnDriverFailure.js';

function atUat() {
  const store = openStore(':memory:');
  const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });
  return { store, id };
}

describe('parkGateOnDriverFailure', () => {
  it('parks a running gate stage blocked with the error text and logs at error', () => {
    const { store, id } = atUat();
    const logError = vi.fn();
    const parked = parkGateOnDriverFailure(store, id, new Error('CHECK constraint failed'), logError);
    expect(parked).toBe(true);
    expect(getStage(store, id, 'uat')).toMatchObject({
      blockedKind: 'capability-missing',
      blockedReason: 'stage driver failed: CHECK constraint failed',
    });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining(`ticket ${id} uat`), expect.any(Error));
    store.close();
  });

  it('leaves an already-blocked stage and a non-gate stage alone', () => {
    const { store, id } = atUat();
    const logError = vi.fn();
    parkGateOnDriverFailure(store, id, new Error('a'), logError);
    expect(parkGateOnDriverFailure(store, id, new Error('b'), logError)).toBe(false);
    expect(getStage(store, id, 'uat')?.blockedReason).toBe('stage driver failed: a');
    store.close();
  });
});
