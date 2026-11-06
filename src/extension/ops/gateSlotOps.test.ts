import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { countGateSlots } from '../../store/gateSlots.js';
import type { GateProcessRunner, ProcessOutcome } from '../../workflow/gates/run.js';
import { withGateSlot, type GateSlotDeps } from './gateSlotOps.js';

const OK: ProcessOutcome = { kind: 'completed', exitCode: 0, output: '' };
let store: Store;
beforeEach(() => { store = openStore(':memory:'); });
afterEach(() => store.close());

const deps = (limit: number, extra: Partial<GateSlotDeps> = {}): GateSlotDeps => ({ store, limit: () => limit, projectIdOf: () => 1, owner: 'w', pollMs: 5, ...extra });
const gate = (): { run: GateProcessRunner; release: () => void; started: () => number } => {
  let n = 0;
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { run: async () => { n++; await wait; return OK; }, release: open, started: () => n };
};
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('withGateSlot', () => {
  it('runs without a store row when the limit is 0 (unlimited)', async () => {
    const g = gate();
    const runs = [1, 2, 3, 4].map((t) => withGateSlot(deps(0), t, g.run)('npm', [], '/wt'));
    await tick();
    expect(g.started()).toBe(4);
    expect(countGateSlots(store, 1)).toBe(0);
    g.release();
    await Promise.all(runs);
  });

  it('makes a third gate wait, says so, and starts it when a slot frees', async () => {
    const g = gate();
    const chunks: string[] = [];
    const d = deps(2);
    const a = withGateSlot(d, 1, g.run)('npm', [], '/wt');
    const b = withGateSlot(d, 2, g.run)('npm', [], '/wt');
    await tick();
    const c = withGateSlot(d, 3, g.run)('npm', [], '/wt', { onOutput: (x) => chunks.push(x.text) });
    await tick();
    expect(g.started()).toBe(2);
    expect(chunks).toEqual(['Waiting for a gate slot (2 running)\n']);
    g.release();
    await Promise.all([a, b, c]);
    expect(g.started()).toBe(3);
    expect(countGateSlots(store, 1)).toBe(0);
  });

  it('releases the slot when the gate throws', async () => {
    const run: GateProcessRunner = () => Promise.reject(new Error('crash'));
    await expect(withGateSlot(deps(1), 1, run)('npm', [], '/wt')).rejects.toThrow('crash');
    expect(countGateSlots(store, 1)).toBe(0);
  });

  it('releases the slot on an aborted outcome', async () => {
    const run: GateProcessRunner = () => Promise.resolve({ kind: 'aborted', output: '' });
    await withGateSlot(deps(1), 1, run)('npm', [], '/wt');
    expect(countGateSlots(store, 1)).toBe(0);
  });

  it('ends a waiting gate as aborted on cancel, without taking a slot', async () => {
    const g = gate();
    const d = deps(1);
    const holder = withGateSlot(d, 1, g.run)('npm', [], '/wt');
    await tick();
    const ctl = new AbortController();
    const waiting = withGateSlot(d, 2, g.run)('npm', [], '/wt', { signal: ctl.signal });
    await tick();
    ctl.abort();
    await expect(waiting).resolves.toMatchObject({ kind: 'aborted' });
    expect(g.started()).toBe(1);
    g.release();
    await holder;
  });

  it('reaps a slot left by a dead window so a waiter starts', async () => {
    store.db.prepare("INSERT INTO gate_slots (ticket_id, project_id, owner, claimed_at, touched_at) VALUES (9, 1, 'dead', '2000-01-01 00:00:00.000', '2000-01-01 00:00:00.000')").run();
    const run = vi.fn<GateProcessRunner>(() => Promise.resolve(OK));
    await withGateSlot(deps(1), 1, run)('npm', [], '/wt');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps a live slot alive with the heartbeat', async () => {
    const g = gate();
    const d = deps(1, { heartbeatMs: 5, staleMs: 60 });
    const a = withGateSlot(d, 1, g.run)('npm', [], '/wt');
    const b = withGateSlot(d, 2, g.run)('npm', [], '/wt');
    await tick(200);
    expect(g.started()).toBe(1);
    g.release();
    await Promise.all([a, b]);
  });
});
