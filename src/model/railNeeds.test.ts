import { describe, it, expect } from 'vitest';
import { railNeeds, type RailNeedsInput } from './railNeeds.js';

const EMPTY = { mergeableRepos: [] as readonly string[] };

function input(over: Partial<RailNeedsInput> = {}): RailNeedsInput {
  return {
    stage: null,
    agentWaiting: false,
    shipStatus: 'pending',
    shipAwaitingMerge: false,
    mergeGate: null,
    ...EMPTY,
    ...over,
  };
}

describe('railNeeds', () => {
  it('says the agent is waiting, and names the way back to it', () => {
    expect(railNeeds(input({ stage: 'impl', agentWaiting: true }))).toEqual({
      detail: 'the agent asked you something',
      action: 'Open session',
      cta: { kind: 'open-session' },
    });
  });

  it('lets the waiting agent outrank a PARKED ship — it is the live question', () => {
    // A waiting agent at a parked ship is a question on screen right now; the
    // confirm will still be there afterwards.
    expect(
      railNeeds(
        input({
          stage: 'ship',
          agentWaiting: true,
          shipStatus: 'pending',
          shipAwaitingMerge: false,
        }),
      )?.action,
    ).toBe('Open session');
  });

  it('does NOT outrank a RUNNING ship — ship is shipping, not asking', () => {
    // Ship is the driver's own agent work: the hooks that set the waiting state
    // fire inside the run itself, so "the agent asked you something" would
    // contradict the shipping in progress (869ed7bpd).
    expect(
      railNeeds(input({ stage: 'ship', agentWaiting: true, shipStatus: 'running' })),
    ).toBeNull();
  });

  it('names the confirm at ship, and the CTA acts on it', () => {
    expect(
      railNeeds(
        input({ stage: 'ship', shipStatus: 'pending', shipAwaitingMerge: false }),
      ),
    ).toEqual({
      detail: 'ready to open the PRs',
      action: 'Confirm ship',
      cta: { kind: 'ship-confirm' },
    });
  });

  it('acts on the single mergeable repo that is still waiting', () => {
    expect(
      railNeeds(
        input({
          stage: 'ship',
          shipStatus: 'passed',
          shipAwaitingMerge: true,
          mergeGate: { kind: 'awaiting', repos: ['api'] },
          mergeableRepos: ['api'],
        }),
      ),
    ).toEqual({ detail: '1 repo to merge', action: 'Merge', cta: { kind: 'merge', repo: 'api' } });
  });

  it('uses the singular for one repo', () => {
    expect(
      railNeeds(
        input({
          stage: 'ship',
          shipStatus: 'passed',
          shipAwaitingMerge: true,
          mergeGate: { kind: 'awaiting', repos: ['a'] },
          mergeableRepos: ['a'],
        }),
      )?.detail,
    ).toBe('1 repo to merge');
  });

  it('points a MULTI-repo wait at the PR panel, never merging blindly', () => {
    // Merge is per-repo with a host confirmation each: a single track-level
    // button cannot pick which of several repos to merge, so it navigates to
    // the panel that owns one Merge button per repo.
    expect(
      railNeeds(
        input({
          stage: 'ship',
          shipStatus: 'passed',
          shipAwaitingMerge: true,
          mergeGate: { kind: 'awaiting', repos: ['a', 'b'] },
          mergeableRepos: ['a', 'b'],
        }),
      ),
    ).toEqual({ detail: '2 repos to merge', action: 'Merge', cta: { kind: 'merge-panel' } });
  });

  it('will not fire a merge for a single repo whose PR cannot currently merge', () => {
    // The panel disables Merge for a draft/closed/unknown PR. The rail must not
    // offer an irreversible command the panel's own control would refuse — a
    // real merge is offered only when the host's `canMerge` verdict is true.
    expect(
      railNeeds(
        input({
          stage: 'ship',
          shipStatus: 'passed',
          shipAwaitingMerge: true,
          mergeGate: { kind: 'awaiting', repos: ['a'] },
          mergeableRepos: [],
        }),
      ),
    ).toEqual({ detail: '1 repo to merge', action: 'Merge', cta: { kind: 'merge-panel' } });
  });

  it('acts on the SINGLE conflicted repo, handing it to a resolve-conflicts session', () => {
    // Ship has no failed edge: a conflict must never read as something a
    // retry could clear, because only a human rebase can. And a single
    // conflicted repo is one the rail can ACT on — the resolve-conflicts
    // session is per-repo and the host re-derives the brief from the store, so
    // this click opens (or nudges) the very session the PR panel's own Resolve
    // button would. Navigating there was the gap this ticket closes.
    expect(
      railNeeds(
        input({
          stage: 'ship',
          shipStatus: 'passed',
          shipAwaitingMerge: true,
          mergeGate: { kind: 'conflicted', repos: ['a'], pending: [] },
        }),
      ),
    ).toEqual({
      detail: '1 repo no longer merges cleanly',
      action: 'Resolve',
      cta: { kind: 'resolve-conflicts', repo: 'a' },
    });
  });

  it('points a MULTI-repo conflict at the PR panel, never resolving blindly', () => {
    // Resolve is per-repo (one conflict brief, one session): a track-level
    // button cannot choose which of several conflicted repos to hand off, so
    // the rail navigates to the panel that owns one Resolve control per repo.
    expect(
      railNeeds(
        input({
          stage: 'ship',
          shipStatus: 'passed',
          shipAwaitingMerge: true,
          mergeGate: { kind: 'conflicted', repos: ['a', 'b'], pending: [] },
        }),
      ),
    ).toEqual({
      detail: '2 repos no longer merge cleanly',
      action: 'Resolve',
      cta: { kind: 'resolve-panel' },
    });
  });

  it('has nothing to say once everything has landed', () => {
    expect(
      railNeeds(
        input({
          stage: 'ship',
          shipStatus: 'passed',
          shipAwaitingMerge: true,
          mergeGate: { kind: 'merged', repos: ['a'] },
        }),
      ),
    ).toBeNull();
    expect(
      railNeeds(
        input({
          stage: 'ship',
          shipStatus: 'passed',
          shipAwaitingMerge: true,
          mergeGate: { kind: 'nothing-to-merge' },
        }),
      ),
    ).toBeNull();
  });

  it('says nothing when blocked on the gate but it has not been read', () => {
    // Absence of a probe is not a state to word; the segment falls back to its
    // stage status rather than inventing one.
    expect(
      railNeeds(
        input({ stage: 'ship', shipStatus: 'passed', shipAwaitingMerge: true }),
      ),
    ).toBeNull();
  });

  it('has nothing to say at a stage that is not parked on anyone', () => {
    expect(railNeeds(input({ stage: 'impl' }))).toBeNull();
    expect(railNeeds(input({ stage: null }))).toBeNull();
  });
});
