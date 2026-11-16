import { describe, it, expect } from 'vitest';
import {
  closeNodeTabOnSuccess,
  closePlannerTabOnAccepted,
  type CloseOnSuccessTransport,
} from './closeOnSuccess.js';
import type { SupervisedAgentSession, TerminationProof } from './transport/agentTransport.js';
import type { CompletionPipelineResult } from './integration/pipeline.js';

const SESSION = { ticketId: 1, nodeRunId: 9, pid: 42 } as unknown as SupervisedAgentSession;

function fixture(proof: TerminationProof | Error = { kind: 'dead' }, session: SupervisedAgentSession | null = SESSION) {
  const calls = { disposed: [] as SupervisedAgentSession[], terminated: 0, looked: [] as Array<[number, number]> };
  const logs: string[] = [];
  const transport: CloseOnSuccessTransport = {
    sessionFor: (t, r) => {
      calls.looked.push([t, r]);
      return session ?? undefined;
    },
    terminate: async () => {
      calls.terminated += 1;
      if (proof instanceof Error) throw proof;
      return proof;
    },
    disposeOnSuccess: (s) => calls.disposed.push(s),
  };
  return { deps: { transport, debug: (m: string) => logs.push(m) }, calls, logs };
}

describe('closeNodeTabOnSuccess', () => {
  it('disposes the node session on integrated', () => {
    const f = fixture();
    expect(closeNodeTabOnSuccess(f.deps, { ticketId: 1, nodeRunId: 9 }, { kind: 'integrated', committed: true })).toBe(true);
    expect(f.calls.disposed).toEqual([SESSION]);
    expect(f.calls.looked).toEqual([[1, 9]]);
  });

  const kept: CompletionPipelineResult[] = [
    { kind: 'no-op' },
    { kind: 'deferred' },
    { kind: 'termination-unknown' },
    { kind: 'output-artifact-missing', artifactId: 'a', reason: 'r' },
    { kind: 'artifact-unsafe', artifactId: 'a', reason: 'r' },
    { kind: 'claim-violated', violations: ['x'] },
    { kind: 'integration-conflict', reason: 'r' },
  ];
  for (const result of kept) {
    it(`keeps the tab open on ${result.kind}`, () => {
      const f = fixture();
      expect(closeNodeTabOnSuccess(f.deps, { ticketId: 1, nodeRunId: 9 }, result)).toBe(false);
      expect(f.calls.disposed).toEqual([]);
    });
  }

  it('is a no-op when no session is registered', () => {
    const f = fixture({ kind: 'dead' }, null);
    expect(closeNodeTabOnSuccess(f.deps, { ticketId: 1, nodeRunId: 9 }, { kind: 'integrated', committed: false })).toBe(false);
    expect(f.calls.disposed).toEqual([]);
  });
});

describe('closePlannerTabOnAccepted', () => {
  const input = { ticketId: 1, plannerRunId: 9, sharesIdWithNodeRun: false };

  it('terminates through the transport, then disposes, on accepted + killed', async () => {
    const f = fixture({ kind: 'attributable', kill: 'killed' });
    expect(await closePlannerTabOnAccepted(f.deps, input, { kind: 'accepted' })).toBe(true);
    expect(f.calls.terminated).toBe(1);
    expect(f.calls.disposed).toEqual([SESSION]);
    expect(f.calls.looked).toEqual([[1, 9]]);
  });

  it('disposes on accepted + dead process', async () => {
    const f = fixture({ kind: 'dead' });
    expect(await closePlannerTabOnAccepted(f.deps, input, { kind: 'accepted' })).toBe(true);
    expect(f.calls.disposed).toHaveLength(1);
  });

  for (const kind of ['repair-requested', 'rejected', 'undecidable', 'no-op']) {
    it(`does nothing on ${kind}`, async () => {
      const f = fixture();
      expect(await closePlannerTabOnAccepted(f.deps, input, { kind })).toBe(false);
      expect(f.calls.terminated).toBe(0);
      expect(f.calls.looked).toEqual([]);
      expect(f.calls.disposed).toEqual([]);
    });
  }

  const unproven: Array<[string, TerminationProof]> = [
    ['unknown', { kind: 'unknown' }],
    ['foreign', { kind: 'foreign' }],
    ['a denied kill', { kind: 'attributable', kill: 'denied' }],
  ];
  for (const [name, proof] of unproven) {
    it(`keeps the tab open when termination is ${name}`, async () => {
      const f = fixture(proof);
      expect(await closePlannerTabOnAccepted(f.deps, input, { kind: 'accepted' })).toBe(false);
      expect(f.calls.disposed).toEqual([]);
      expect(f.logs.join('\n')).toContain('not proven');
    });
  }

  it('keeps the tab open and logs when terminate throws', async () => {
    const f = fixture(new Error('boom'));
    expect(await closePlannerTabOnAccepted(f.deps, input, { kind: 'accepted' })).toBe(false);
    expect(f.calls.disposed).toEqual([]);
    expect(f.logs.join('\n')).toContain('boom');
  });

  it('is a no-op without a session (a repeated accepted result)', async () => {
    const f = fixture({ kind: 'dead' }, null);
    expect(await closePlannerTabOnAccepted(f.deps, input, { kind: 'accepted' })).toBe(false);
    expect(f.calls.terminated).toBe(0);
  });

  it('keeps the tab open when the accepted planner run is unknown', async () => {
    const f = fixture();
    expect(await closePlannerTabOnAccepted(f.deps, { ...input, plannerRunId: undefined }, { kind: 'accepted' })).toBe(false);
    expect(f.calls.looked).toEqual([]);
    expect(f.logs.join('\n')).toContain('no accepted planner run');
  });

  it('never matches a node session that shares the planner run id', async () => {
    const f = fixture();
    expect(await closePlannerTabOnAccepted(f.deps, { ...input, sharesIdWithNodeRun: true }, { kind: 'accepted' })).toBe(false);
    expect(f.calls.terminated).toBe(0);
    expect(f.calls.disposed).toEqual([]);
  });
});
