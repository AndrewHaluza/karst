import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `extension.ts` cannot load under vitest, so the host order of the graph tick
// is pinned on the source text. The e2e harness (`tickGraphRun`) copies this order.
describe('runGraphCoordinatorTick order', () => {
  const source = readFileSync(new URL('../extension.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const runGraphCoordinatorTick = async');
  const end = source.indexOf('const graphRouteFor = ', start);
  const body = source.slice(start, end);

  it('finds the function body', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('settles the run before the coordinator tick, so a replan request elects before the sweep reads it as a fault', () => {
    const settle = body.indexOf('settleGraphRun(gs.db, graphRunId)');
    const tick = body.indexOf('runCoordinatorTick(');
    expect(settle).toBeGreaterThan(-1);
    expect(tick).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(tick);
  });
});
