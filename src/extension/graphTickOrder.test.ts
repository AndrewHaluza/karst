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

  it('records the claim evidence before the pre-tick settle, so a violation replans and is not settled as node-blocked', () => {
    const evidence = body.indexOf('await graphClaimEvidence(graphRunId)');
    const settle = body.indexOf('settleGraphRun(gs.db, graphRunId)');
    expect(evidence).toBeGreaterThan(-1);
    expect(evidence).toBeLessThan(settle);
  });

  it('records the claim evidence before the settle of the completing drive, with no other await between them', () => {
    const driveStart = source.indexOf('const driveCompletingNodes = async');
    const drive = source.slice(driveStart, source.indexOf('const autoFireImplMarker = ', driveStart));
    const evidence = drive.indexOf('await graphClaimEvidence(graphRunId)');
    const settle = drive.indexOf('settleGraphRun(gs.db, graphRunId)');
    expect(evidence).toBeGreaterThan(-1);
    expect(evidence).toBeLessThan(settle);
    expect(drive.slice(evidence + 'await'.length, settle)).not.toContain('await ');
  });

  it('skips the sweep when the pre-tick settle fails, so a busy settle cannot park a replan request', () => {
    const catchAt = body.indexOf('graph pre-tick settle failed');
    const returnAt = body.indexOf('return;', catchAt);
    const tick = body.indexOf('runCoordinatorTick(');
    expect(catchAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(catchAt);
    expect(returnAt).toBeLessThan(tick);
  });
});
