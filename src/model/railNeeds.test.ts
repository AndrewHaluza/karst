import { describe, it, expect } from 'vitest';
import { railNeeds } from './railNeeds.js';

describe('railNeeds', () => {
  it('says the agent is waiting, and names the way back to it', () => {
    expect(
      railNeeds({
        stage: 'impl',
        agentWaiting: true,
        shipStatus: 'pending',
        shipAwaitingMerge: false,
        mergeGate: null,
      }),
    ).toEqual({
      detail: 'the agent asked you something',
      action: 'Open session',
    });
  });

  it('lets the waiting agent outrank a PARKED ship — it is the live question', () => {
    // A waiting agent at a parked ship is a question on screen right now; the
    // confirm will still be there afterwards.
    expect(
      railNeeds({
        stage: 'ship',
        agentWaiting: true,
        shipStatus: 'pending',
        shipAwaitingMerge: false,
        mergeGate: null,
      })?.action,
    ).toBe('Open session');
  });

  it('does NOT outrank a RUNNING ship — ship is shipping, not asking', () => {
    // Ship is the driver's own agent work: the hooks that set the waiting state
    // fire inside the run itself, so "the agent asked you something" would
    // contradict the shipping in progress (869ed7bpd).
    expect(
      railNeeds({
        stage: 'ship',
        agentWaiting: true,
        shipStatus: 'running',
        shipAwaitingMerge: false,
        mergeGate: null,
      }),
    ).toBeNull();
  });

  it('names the confirm at ship', () => {
    expect(
      railNeeds({
        stage: 'ship',
        agentWaiting: false,
        shipStatus: 'pending',
        shipAwaitingMerge: false,
        mergeGate: null,
      }),
    ).toEqual({
      detail: 'ready to open the PRs',
      action: 'Confirm ship',
    });
  });

  it('names the merge, with the repo count still waiting', () => {
    expect(
      railNeeds({
        stage: 'ship',
        agentWaiting: false,
        shipStatus: 'passed',
        shipAwaitingMerge: true,
        mergeGate: { kind: 'awaiting', repos: ['a', 'b'] },
      }),
    ).toEqual({ detail: '2 repos to merge', action: 'Merge' });
  });

  it('uses the singular for one repo', () => {
    expect(
      railNeeds({
        stage: 'ship',
        agentWaiting: false,
        shipStatus: 'passed',
        shipAwaitingMerge: true,
        mergeGate: { kind: 'awaiting', repos: ['a'] },
      })?.detail,
    ).toBe('1 repo to merge');
  });

  it('words a conflict as a conflict, never as a failure', () => {
    // Ship has no failed edge: a conflict must never read as something a
    // retry could clear, because only a human rebase can.
    expect(
      railNeeds({
        stage: 'ship',
        agentWaiting: false,
        shipStatus: 'passed',
        shipAwaitingMerge: true,
        mergeGate: { kind: 'conflicted', repos: ['a'], pending: [] },
      }),
    ).toEqual({ detail: '1 repo no longer merges cleanly', action: 'Resolve' });
  });

  it('agrees the verb with the repo count', () => {
    expect(
      railNeeds({
        stage: 'ship',
        agentWaiting: false,
        shipStatus: 'passed',
        shipAwaitingMerge: true,
        mergeGate: { kind: 'conflicted', repos: ['a', 'b'], pending: [] },
      })?.detail,
    ).toBe('2 repos no longer merge cleanly');
  });

  it('has nothing to say once everything has landed', () => {
    expect(
      railNeeds({
        stage: 'ship',
        agentWaiting: false,
        shipStatus: 'passed',
        shipAwaitingMerge: true,
        mergeGate: { kind: 'merged', repos: ['a'] },
      }),
    ).toBeNull();
    expect(
      railNeeds({
        stage: 'ship',
        agentWaiting: false,
        shipStatus: 'passed',
        shipAwaitingMerge: true,
        mergeGate: { kind: 'nothing-to-merge' },
      }),
    ).toBeNull();
  });

  it('says nothing when blocked on the gate but it has not been read', () => {
    // Absence of a probe is not a state to word; the segment falls back to its
    // stage status rather than inventing one.
    expect(
      railNeeds({
        stage: 'ship',
        agentWaiting: false,
        shipStatus: 'passed',
        shipAwaitingMerge: true,
        mergeGate: null,
      }),
    ).toBeNull();
  });

  it('has nothing to say at a stage that is not parked on anyone', () => {
    expect(
      railNeeds({
        stage: 'impl',
        agentWaiting: false,
        shipStatus: 'pending',
        shipAwaitingMerge: false,
        mergeGate: null,
      }),
    ).toBeNull();
    expect(
      railNeeds({
        stage: null,
        agentWaiting: false,
        shipStatus: 'pending',
        shipAwaitingMerge: false,
        mergeGate: null,
      }),
    ).toBeNull();
  });
});
