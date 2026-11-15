import { describe, expect, it, vi } from 'vitest';
import { remedyBaseMoved, type BaseMovedRemedyDeps } from './baseMovedRemedy.js';

const CMD = 'npm run -s docs:graph';
const STALE = { summary: `docs/arch/system-map.md is stale: run ${CMD}` };

function deps(over: Partial<BaseMovedRemedyDeps> = {}): BaseMovedRemedyDeps {
  return {
    failedGates: () => [STALE],
    regenerate: [CMD],
    rebase: vi.fn(async () => ({ moved: true, error: null })),
    gates: vi.fn(async () => null),
    debug: vi.fn(),
    ...over,
  };
}

describe('remedyBaseMoved', () => {
  it('rebases once and gates the new head for a stale-only failure', async () => {
    const d = deps();
    const r = await remedyBaseMoved(d);
    expect(r).toEqual({ kind: 'rebased', detail: `rebased on base and regenerated (${CMD}); the gates pass on the new head` });
    expect(d.rebase).toHaveBeenCalledTimes(1);
    expect(d.gates).toHaveBeenCalledTimes(1);
  });
  it('runs the gates after the rebase, never before', async () => {
    const order: string[] = [];
    const d = deps({ rebase: async () => { order.push('rebase'); return { moved: true, error: null }; }, gates: async () => { order.push('gates'); return null; } });
    await remedyBaseMoved(d);
    expect(order).toEqual(['rebase', 'gates']);
  });
  it('(b) starts no rebase when another gate fails too', async () => {
    const d = deps({ failedGates: () => [STALE, { summary: 'FAIL a.test.ts > x > y' }] });
    expect(await remedyBaseMoved(d)).toBeNull();
    expect(d.rebase).not.toHaveBeenCalled();
  });
  it('starts no rebase when no gate row failed', async () => {
    const d = deps({ failedGates: () => [] });
    expect(await remedyBaseMoved(d)).toBeNull();
    expect(d.rebase).not.toHaveBeenCalled();
  });
  it('refuses when the rebase reports an error, and runs no gate', async () => {
    const d = deps({ rebase: async () => ({ moved: true, error: 'conflict' }) });
    expect(await remedyBaseMoved(d)).toEqual({ kind: 'refused', reason: expect.stringContaining('conflict') });
    expect(d.gates).not.toHaveBeenCalled();
  });
  it('refuses when the rebase throws', async () => {
    const d = deps({ rebase: async () => { throw new Error('boom'); } });
    expect(await remedyBaseMoved(d)).toEqual({ kind: 'refused', reason: expect.stringContaining('boom') });
    expect(d.gates).not.toHaveBeenCalled();
  });
  it('refuses when the rebase moved nothing', async () => {
    const d = deps({ rebase: async () => ({ moved: false, error: null }) });
    expect(await remedyBaseMoved(d)).toEqual({ kind: 'refused', reason: expect.stringContaining('moved nothing') });
    expect(d.gates).not.toHaveBeenCalled();
  });
  it('(c) refuses when the gates fail again on the rebased head', async () => {
    const d = deps({ gates: async () => 'repo: gate "docs-graph" failed (exit 1)' });
    expect(await remedyBaseMoved(d)).toEqual({ kind: 'refused', reason: expect.stringContaining('docs-graph') });
    expect(d.rebase).toHaveBeenCalledTimes(1);
  });
  it('refuses when the gate run throws', async () => {
    const d = deps({ gates: async () => { throw new Error('spawn failed'); } });
    expect(await remedyBaseMoved(d)).toEqual({ kind: 'refused', reason: expect.stringContaining('spawn failed') });
  });
  it('writes one debug line before the rebase', async () => {
    const d = deps();
    await remedyBaseMoved(d);
    expect(d.debug).toHaveBeenCalledTimes(1);
    expect(d.debug).toHaveBeenCalledWith(`[ship] base-moved: only a stale generated file failed (${CMD}); the host rebases on base`);
  });
});
