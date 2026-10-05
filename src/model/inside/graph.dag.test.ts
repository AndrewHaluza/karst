import { describe, expect, it } from 'vitest';
import { graphDagView } from './graphDag.js';
import type { GraphNodeListRow } from './types.js';

const entry = (over: Partial<GraphNodeListRow> & { nodeId: string }): GraphNodeListRow => ({
  entry: 'node',
  nodeKind: 'agent',
  status: 'completed',
  displayStatus: 'pass',
  identity: '',
  ...over,
});
const topo = (ids: string[], edges: [string, string][]) => ({
  nodes: ids.map((id) => ({ id })),
  edges: edges.map(([from, to]) => ({ from, to })),
});
const ids = (d: ReturnType<typeof graphDagView>) => d.columns.map((c) => c.map((x) => x.id));

describe('graphDagView', () => {
  it('lays out by longest-path depth with parallel nodes stacked', () => {
    const d = graphDagView(topo(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['a', 'd']]), []);
    expect(ids(d)).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('puts the planner chip leftmost from the latest planner entry', () => {
    const d = graphDagView(topo(['a'], []), [
      entry({ entry: 'planner', nodeId: 'planner 1', status: 'submitted', displayStatus: 'pass' }),
      entry({ entry: 'planner', nodeId: 'planner 2', status: 'running', displayStatus: 'run', age: 'running 3m' }),
    ]);
    expect(ids(d)).toEqual([['planner 2'], ['a']]);
    expect(d.columns[0]![0]!.state).toBe('running 3m');
  });

  it('uses the latest ledger entry for status/state and pending otherwise', () => {
    const d = graphDagView(topo(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]), [
      entry({ nodeId: 'a' }),
      entry({ nodeId: 'b', status: 'running', displayStatus: 'run', age: 'running 10m' }),
      entry({ entry: 'deferred', nodeId: 'b', status: 'deferred', displayStatus: 'wait', age: 'waiting 1m' }),
    ]);
    const chips = d.columns.flat();
    expect(chips.find((c) => c.id === 'b')).toMatchObject({ displayStatus: 'wait', state: 'deferred' });
    expect(chips.find((c) => c.id === 'a')).toMatchObject({ displayStatus: 'pass', state: 'completed' });
    expect(chips.find((c) => c.id === 'c')).toMatchObject({ displayStatus: 'pending', state: 'pending' });
  });

  it('shows running age as state', () => {
    const d = graphDagView(topo(['a'], []), [entry({ nodeId: 'a', status: 'running', displayStatus: 'run', age: 'running 10m' })]);
    expect(d.columns[0]![0]!.state).toBe('running 10m');
  });

  it('is cycle safe: back-edges are ignored and every node is placed once', () => {
    const d = graphDagView(topo(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['b', 'b']]), []);
    expect(ids(d)).toEqual([['a'], ['b'], ['c']]);
    const pure = graphDagView(topo(['x', 'y'], [['x', 'y'], ['y', 'x']]), []);
    expect(pure.columns.flat().map((c) => c.id).sort()).toEqual(['x', 'y']);
  });

  it('ignores edges to unknown nodes and duplicate node ids', () => {
    const d = graphDagView(topo(['a', 'a', 'b'], [['a', 'zzz'], ['a', 'b']]), []);
    expect(ids(d)).toEqual([['a'], ['b']]);
  });

  it('bounds columns and chips with a +N more remainder', () => {
    const chain = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const d = graphDagView(topo(chain, chain.slice(1).map((n, i) => [chain[i]!, n] as [string, string])), []);
    expect(d.columns).toHaveLength(12);
    expect(d.more).toBe('+8 more');
    const wide = Array.from({ length: 60 }, (_, i) => `w${i}`);
    const w = graphDagView(topo(wide, []), []);
    expect(w.columns.flat()).toHaveLength(40);
    expect(w.more).toBe('+20 more');
  });

  it('sanitizes labels and state text', () => {
    const d = graphDagView(topo(['a\u001b[31m<x>\n'], []), [
      entry({ nodeId: 'a\u001b[31m<x>\n', status: 'run\u0007ning', age: 'running\u001b[0m 1m' }),
    ]);
    const chip = d.columns[0]![0]!;
    // eslint-disable-next-line no-control-regex
    expect(chip.label + chip.state).not.toMatch(/[\u0000-\u001f\u001b]/);
  });

  it('is empty-safe', () => {
    expect(graphDagView(topo([], []), []).columns).toEqual([]);
  });
});
