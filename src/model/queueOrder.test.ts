import { describe, expect, it } from 'vitest';
import { orderQueue, queueWhy, type QueueEdge, type QueueItem } from './queueOrder.js';

const item = (id: string, priority: QueueItem['priority'] = null, createdAt = '2026-01-01 00:00:00', waits?: string[]): QueueItem => ({
  id,
  priority,
  createdAt,
  ...(waits ? { externalWaits: waits } : {}),
});
/** `a` waits on `b` (b is placed first). */
const waits = (a: string, b: string): QueueEdge => ({ from: a, to: b });
const ids = (r: ReturnType<typeof orderQueue>): string[] => r.map((x) => x.id);

describe('orderQueue', () => {
  it('returns an empty list for no input', () => {
    expect(orderQueue([], [])).toEqual([]);
  });

  it('orders by priority, then age, then id', () => {
    const r = orderQueue(
      [
        item('D3', 'low'),
        item('D2', null, '2026-01-02 00:00:00'),
        item('D1', null, '2026-01-03 00:00:00'),
        item('T9', 'urgent', '2026-02-01 00:00:00'),
        item('D5', 'normal', '2026-01-02 00:00:00'),
      ],
      [],
    );
    expect(ids(r)).toEqual(['T9', 'D2', 'D5', 'D1', 'D3']);
    expect(r.map((x) => x.position)).toEqual([1, 2, 3, 4, 5]);
    expect(r[1]!.priority).toBe('normal');
  });

  it('breaks a full tie by id, numerically and drafts before tickets', () => {
    expect(ids(orderQueue([item('T1'), item('D10'), item('D9')], []))).toEqual(['D9', 'D10', 'T1']);
  });

  it('puts a blocker before the item that waits on it, whatever the priority', () => {
    const r = orderQueue([item('D1', 'urgent'), item('D2', 'low')], [waits('D1', 'D2')]);
    expect(ids(r)).toEqual(['D2', 'D1']);
    expect(r[0]).toMatchObject({ priority: 'urgent', inheritedFrom: 'D1', waitsOn: [] });
    expect(r[1]).toMatchObject({ priority: 'urgent', inheritedFrom: null, waitsOn: ['D2'] });
  });

  it('orders a chain from the root blocker up', () => {
    const r = orderQueue([item('D1'), item('D2'), item('D3')], [waits('D1', 'D2'), waits('D2', 'D3')]);
    expect(ids(r)).toEqual(['D3', 'D2', 'D1']);
  });

  it('inherits through two hops and names the item that raised it', () => {
    const r = orderQueue(
      [item('D1', 'high'), item('D2', 'low'), item('D3', null)],
      [waits('D1', 'D2'), waits('D2', 'D3')],
    );
    expect(ids(r)).toEqual(['D3', 'D2', 'D1']);
    expect(r[0]).toMatchObject({ priority: 'high', inheritedFrom: 'D1' });
    expect(r[1]).toMatchObject({ priority: 'high', inheritedFrom: 'D1' });
    expect(r[2]).toMatchObject({ priority: 'high', inheritedFrom: null });
  });

  it('keeps the highest inherited level in a diamond', () => {
    // D1 and D2 both wait on D3; D4 (low) is unrelated and ready.
    const r = orderQueue(
      [item('D1', 'urgent'), item('D2', 'high'), item('D3', 'low'), item('D4', 'normal')],
      [waits('D1', 'D3'), waits('D2', 'D3')],
    );
    expect(ids(r)).toEqual(['D3', 'D1', 'D2', 'D4']);
    expect(r[0]).toMatchObject({ priority: 'urgent', inheritedFrom: 'D1' });
    expect(r[0]!.waitsOn).toEqual([]);
    expect(r[1]!.waitsOn).toEqual(['D3']);
  });

  it('does not inherit a lower level and does not mark an item that keeps its own', () => {
    const r = orderQueue([item('D1', 'low'), item('D2', 'high')], [waits('D1', 'D2')]);
    expect(r[0]).toMatchObject({ id: 'D2', priority: 'high', inheritedFrom: null });
  });

  it('never throws on a cycle: places the members by the tie keys and marks them', () => {
    const r = orderQueue(
      [item('D1', null, '2026-01-02 00:00:00'), item('D2', null, '2026-01-01 00:00:00'), item('D3', 'high'), item('D4')],
      [waits('D1', 'D2'), waits('D2', 'D1'), waits('D4', 'D1')],
    );
    expect(ids(r)).toEqual(['D3', 'D2', 'D1', 'D4']);
    expect(r.map((x) => x.cycle)).toEqual([false, true, true, false]);
  });

  it('ignores a self edge, a duplicate edge and an edge to an unknown id', () => {
    const r = orderQueue([item('D1'), item('D2')], [waits('D1', 'D1'), waits('D1', 'D2'), waits('D1', 'D2'), waits('D1', 'D9')]);
    expect(ids(r)).toEqual(['D2', 'D1']);
    expect(r[1]!.waitsOn).toEqual(['D2']);
    expect(r.every((x) => !x.cycle)).toBe(true);
  });

  it('lists an external open blocker in waitsOn without ordering by it', () => {
    const r = orderQueue([item('D1', null, '2026-01-01 00:00:00', ['T12']), item('D2', null, '2026-01-02 00:00:00')], []);
    expect(ids(r)).toEqual(['D1', 'D2']);
    expect(r[0]!.waitsOn).toEqual(['T12']);
  });

  it('does not mutate its input', () => {
    const items = [item('D1', 'high'), item('D2')];
    const edges = [waits('D2', 'D1')];
    const copy = JSON.stringify([items, edges]);
    orderQueue(items, edges);
    expect(JSON.stringify([items, edges])).toBe(copy);
  });
});

describe('queueWhy', () => {
  const base = { id: 'D1', position: 1, priority: 'normal', inheritedFrom: null, waitsOn: [], cycle: false } as const;
  it('is empty with nothing to explain', () => {
    expect(queueWhy(base)).toBe('');
  });
  it('names a cycle first', () => {
    expect(queueWhy({ ...base, cycle: true, inheritedFrom: 'D2', waitsOn: ['D3'] })).toBe('cycle');
  });
  it('names the item that raised the priority', () => {
    expect(queueWhy({ ...base, inheritedFrom: 'D498' })).toBe('↑ from D498');
  });
  it('names the open blockers', () => {
    expect(queueWhy({ ...base, waitsOn: ['T12', 'D4'] })).toBe('waits on T12, D4');
  });
});
