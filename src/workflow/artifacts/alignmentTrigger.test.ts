import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ArtifactChain } from './chain.js';
import { ALIGNMENT_DEBOUNCE_MS, createAlignmentTrigger, mediumPlus, type TriggerDeps } from './alignmentTrigger.js';

const planOnly: ArtifactChain = {
  intent: 'I',
  spec: null,
  plan: { kind: 'plan', files: [{ relPath: 'p.md', repo: 'r', sha: '1', text: 'P' }] },
};
const specAndPlan: ArtifactChain = {
  intent: 'I',
  spec: { kind: 'spec', files: [{ relPath: 's.md', repo: 'r', sha: '9', text: 'S' }] },
  plan: planOnly.plan,
};

function setup(over: Partial<TriggerDeps> = {}) {
  const calls: { edge: string }[] = [];
  const record = vi.fn();
  const deps: TriggerDeps = {
    loadChain: async () => planOnly,
    approachFor: () => ({ id: 'mine', label: 'M' }),
    run: async (i) => {
      calls.push(i);
      return { findings: [], report: 'R', failed: false };
    },
    record,
    ...over,
  };
  return { calls, record, trigger: createAlignmentTrigger(deps) };
}
const rev = (kind: string) => ({ ticketId: 1, kind });
const settle = () => vi.advanceTimersByTimeAsync(ALIGNMENT_DEBOUNCE_MS);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('alignment trigger', () => {
  it('debounces bursts into one run per ticket', async () => {
    const { calls, trigger } = setup();
    trigger.onRevision(rev('plan'));
    trigger.onRevision(rev('plan'));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.edge).toBe('intent-plan');
  });
  it('ignores non spec/plan kinds', async () => {
    const { calls, trigger } = setup();
    trigger.onRevision(rev('research'));
    await settle();
    expect(calls).toHaveLength(0);
  });
  it('skips an edge the approach declares in checks', async () => {
    const { calls, trigger } = setup({ approachFor: () => ({ id: 'mine', label: 'M', checks: ['intent-plan'] }) });
    trigger.onRevision(rev('plan'));
    await settle();
    expect(calls).toHaveLength(0);
  });
  it('skips when fingerprints are unchanged after a successful run', async () => {
    const { calls, trigger } = setup();
    trigger.onRevision(rev('plan'));
    await settle();
    trigger.onRevision(rev('plan'));
    await settle();
    expect(calls).toHaveLength(1);
  });
  it('records the report with fingerprints (warn only)', async () => {
    const { record, trigger } = setup();
    trigger.onRevision(rev('plan'));
    await settle();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 1, edge: 'intent-plan', report: 'R', parentFp: expect.any(String), childFp: expect.any(String) }),
    );
  });
  it('a spec revision also re-checks spec-plan when a plan exists', async () => {
    const { calls, trigger } = setup({ loadChain: async () => specAndPlan });
    trigger.onRevision(rev('spec'));
    await settle();
    expect(calls.map((c) => c.edge).sort()).toEqual(['intent-spec', 'spec-plan']);
  });
  it('a failed run is retried on the next revision with the same shas', async () => {
    const calls: unknown[] = [];
    const { trigger } = setup({
      run: async (i) => {
        calls.push(i);
        return { findings: [], report: 'R', failed: true };
      },
    });
    trigger.onRevision(rev('plan'));
    await settle();
    trigger.onRevision(rev('plan'));
    await settle();
    expect(calls).toHaveLength(2);
  });
  it('a record failure on one edge does not stop the next edge and never rejects', async () => {
    const debug: string[] = [];
    let records = 0;
    const { calls, trigger } = setup({
      loadChain: async () => specAndPlan,
      record: () => {
        records += 1;
        if (records === 1) throw new Error('record boom');
      },
      debug: (m) => debug.push(m),
    });
    trigger.onRevision(rev('spec'));
    await settle();
    expect(calls.map((c) => c.edge).sort()).toEqual(['intent-spec', 'spec-plan']);
    expect(debug.join('\n')).toMatch(/record boom/);
  });
  it('a loadChain failure is logged, not thrown', async () => {
    const debug: string[] = [];
    const { trigger } = setup({
      loadChain: async () => {
        throw new Error('store down');
      },
      debug: (m) => debug.push(m),
    });
    trigger.onRevision(rev('plan'));
    await settle();
    expect(debug.join('\n')).toMatch(/store down/);
  });
  it('dispose cancels a pending run', async () => {
    const { calls, trigger } = setup();
    trigger.onRevision(rev('plan'));
    trigger.dispose();
    await settle();
    expect(calls).toHaveLength(0);
  });
});

it('mediumPlus counts critical, high and medium, never low', () => {
  expect(
    mediumPlus([{ severity: 'critical' }, { severity: 'high' }, { severity: 'medium' }, { severity: 'low' }] as never),
  ).toBe(3);
});
