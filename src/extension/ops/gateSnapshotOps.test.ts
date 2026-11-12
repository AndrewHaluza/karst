import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { getGateSnapshot, setGateSnapshot } from '../../store/ticketGates.js';
import type { GateOptions } from '../../ui/dashboard/gateOptions.js';
import { takeGateSnapshot } from './gateSnapshotOps.js';

const options = (uat: string[], review: string[]): GateOptions => ({
  uat: uat.map((name) => ({ name, disabled: false })),
  review: review.map((name) => ({ name, disabled: false })),
});

function setup() {
  const store = openStore(':memory:');
  const id = createTicket(store, { key: 'K-1', title: 'A ticket', source: 'manual' }).id;
  return { store, id };
}

describe('takeGateSnapshot', () => {
  it('stores the resolved gate names of both stages', async () => {
    const { store, id } = setup();
    const ok = await takeGateSnapshot({ store, loadGateOptions: async () => options(['unit'], ['lint', 'layer-rules']) }, id);
    expect(ok).toBe(true);
    expect(getGateSnapshot(store, id)).toEqual({ uat: ['unit'], review: ['lint', 'layer-rules'] });
  });

  it('replaces an existing snapshot by default', async () => {
    const { store, id } = setup();
    setGateSnapshot(store, id, { uat: ['unit'], review: ['lint'] });
    await takeGateSnapshot({ store, loadGateOptions: async () => options(['unit'], ['lint', 'layer-rules']) }, id);
    expect(getGateSnapshot(store, id)?.review).toEqual(['lint', 'layer-rules']);
  });

  it('keeps an existing snapshot when onlyIfMissing is set', async () => {
    const { store, id } = setup();
    setGateSnapshot(store, id, { uat: ['unit'], review: ['lint'] });
    const ok = await takeGateSnapshot(
      { store, loadGateOptions: async () => options(['unit'], ['lint', 'layer-rules']) },
      id,
      { onlyIfMissing: true },
    );
    expect(ok).toBe(false);
    expect(getGateSnapshot(store, id)?.review).toEqual(['lint']);
  });

  it('writes nothing when the loader resolved no gate at all (failed read must not skip every gate)', async () => {
    const { store, id } = setup();
    setGateSnapshot(store, id, { uat: ['unit'], review: ['lint'] });
    const ok = await takeGateSnapshot({ store, loadGateOptions: async () => options([], []) }, id);
    expect(ok).toBe(false);
    expect(getGateSnapshot(store, id)).toEqual({ uat: ['unit'], review: ['lint'] });
  });

  it('writes nothing and does not throw when the loader throws', async () => {
    const { store, id } = setup();
    const debug: string[] = [];
    const ok = await takeGateSnapshot(
      { store, loadGateOptions: async () => { throw new Error('git down'); }, debug: (m) => debug.push(m) },
      id,
    );
    expect(ok).toBe(false);
    expect(getGateSnapshot(store, id)).toBeNull();
    expect(debug.join('\n')).toContain('git down');
  });
});
