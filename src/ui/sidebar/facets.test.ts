import { describe, it, expect } from 'vitest';
import {
  facetOf,
  matchesSelection,
  filterBySelection,
  toggleFacet,
  normalizeSelection,
  facetCounts,
  FACETS,
} from './facets.js';
import type { TicketWithStages } from '../../store/tickets.js';
import type { StageKey } from '../../model/types.js';

function ticket(over: Partial<TicketWithStages> = {}): TicketWithStages {
  return {
    id: 1,
    key: 'PROJ-1',
    title: 'a thing',
    source: 'manual',
    stageCurrent: 'impl',
    agentState: 'none',
    sessionId: null,
    description: null,
    brief: null,
    sourceRef: null,
    sourceFetchedAt: null,
    approach: null,
    agent: null,
    selectedRepos: [],
    archivedAt: null,
    updatedAt: null,
    model: null,
    agentProvider: null,
    sessionProvider: null,
    type: null,
    projectId: null,
    parentTicketId: null,
    priority: null,
    stages: [
      {
        ticketId: 1,
        stageKey: 'impl',
        status: 'running',
        attempt: 0,
        verdict: null,
        artifactPath: null,
        startedAt: null,
        endedAt: null,
        blockedKind: null,
        blockedReason: null,
        blockedAt: null,
      },
    ],
    ...over,
  };
}

const stage = (key: StageKey, status: TicketWithStages['stages'][number]['status']) => ({
  ticketId: 1,
  stageKey: key,
  status,
  attempt: 0,
  verdict: null,
  artifactPath: null,
  startedAt: null,
  endedAt: null,
  blockedKind: null,
  blockedReason: null,
  blockedAt: null,
});

describe('facetOf', () => {
  it('running current stage => running (in progress)', () => {
    expect(facetOf(ticket({ stageCurrent: 'impl', stages: [stage('impl', 'running')] }))).toBe('running');
  });

  it('waiting agent => input (needs you), wins over stage', () => {
    expect(facetOf(ticket({ agentState: 'waiting', stageCurrent: 'scope', stages: [stage('scope', 'pending')] }))).toBe('input');
  });

  it('failed current stage => failed (blocked)', () => {
    expect(facetOf(ticket({ stageCurrent: 'uat', stages: [stage('uat', 'failed')] }))).toBe('failed');
  });

  it('passed current stage => done (shipped)', () => {
    expect(facetOf(ticket({ stageCurrent: 'done', stages: [stage('done', 'passed')] }))).toBe('done');
  });

  it('pending/idle => null (only in All)', () => {
    expect(facetOf(ticket({ stageCurrent: 'scope', agentState: 'none', stages: [stage('scope', 'pending')] }))).toBeNull();
  });

  // "Needs you" had no members before this: the only ticket that is genuinely
  // blocked on the user — one parked at ship — filed itself under "In progress".
  it('parked at ship => input (needs you), with no agent waiting', () => {
    expect(facetOf(ticket({ stageCurrent: 'ship', agentState: 'idle', stages: [stage('ship', 'pending')] }))).toBe('input');
  });

  it('a ship in flight stays in progress, not needs-you', () => {
    expect(facetOf(ticket({ stageCurrent: 'ship', agentState: 'idle', stages: [stage('ship', 'running')] }))).toBe('running');
  });
});

describe('matchesSelection', () => {
  const running = ticket({ stageCurrent: 'impl', stages: [stage('impl', 'running')] });
  it('all (empty union) matches everything', () => {
    expect(matchesSelection(running, ['all'])).toBe(true);
    expect(matchesSelection(ticket({ stageCurrent: 'scope', stages: [stage('scope', 'pending')] }), ['all'])).toBe(true);
  });
  it('a single status matches only its own tickets', () => {
    expect(matchesSelection(running, ['running'])).toBe(true);
    expect(matchesSelection(running, ['failed'])).toBe(false);
  });
  it('a union matches a ticket in ANY selected status', () => {
    expect(matchesSelection(running, ['running', 'failed'])).toBe(true);
    expect(matchesSelection(running, ['input', 'failed'])).toBe(false);
  });
  it('archived never matches an active ticket', () => {
    expect(matchesSelection(running, ['archived'])).toBe(false);
  });
});

describe('normalizeSelection', () => {
  it('empty collapses to [all]', () => {
    expect(normalizeSelection([])).toEqual(['all']);
    expect(normalizeSelection(['all'])).toEqual(['all']);
  });
  it('drops all when a real status is present', () => {
    expect(normalizeSelection(['all', 'failed'])).toEqual(['failed']);
  });
  it('archived wins and drops everything else', () => {
    expect(normalizeSelection(['archived', 'failed', 'all'])).toEqual(['archived']);
  });
  it('dedups and orders by FACETS', () => {
    expect(normalizeSelection(['done', 'running', 'running', 'input'])).toEqual(['running', 'input', 'done']);
  });
});

describe('toggleFacet', () => {
  it('all resets any selection', () => {
    expect(toggleFacet(['running', 'failed'], 'all')).toEqual(['all']);
  });
  it('a status adds to the union, dropping all', () => {
    expect(toggleFacet(['all'], 'running')).toEqual(['running']);
    expect(toggleFacet(['running'], 'failed')).toEqual(['running', 'failed']);
  });
  it('toggling a lit status removes it; emptying returns to all', () => {
    expect(toggleFacet(['running', 'failed'], 'failed')).toEqual(['running']);
    expect(toggleFacet(['running'], 'running')).toEqual(['all']);
  });
  it('archived is exclusive; toggling it off returns to all', () => {
    expect(toggleFacet(['running'], 'archived')).toEqual(['archived']);
    expect(toggleFacet(['archived'], 'archived')).toEqual(['all']);
  });
  it('a status click while archived leaves archived for that status', () => {
    expect(toggleFacet(['archived'], 'failed')).toEqual(['failed']);
  });
});

describe('filterBySelection + facetCounts', () => {
  const tickets = [
    ticket({ id: 1, stageCurrent: 'impl', stages: [stage('impl', 'running')] }),       // running
    ticket({ id: 2, agentState: 'waiting', stageCurrent: 'scope', stages: [stage('scope', 'pending')] }), // input
    ticket({ id: 3, stageCurrent: 'uat', stages: [stage('uat', 'failed')] }),           // failed
    ticket({ id: 4, stageCurrent: 'scope', stages: [stage('scope', 'pending')] }),      // none
  ];

  it('filters to the selection, all returns everything', () => {
    expect(filterBySelection(tickets, ['all'])).toHaveLength(4);
    expect(filterBySelection(tickets, ['running']).map((t) => t.id)).toEqual([1]);
    expect(filterBySelection(tickets, ['input']).map((t) => t.id)).toEqual([2]);
    expect(filterBySelection(tickets, ['failed']).map((t) => t.id)).toEqual([3]);
  });

  it('a union returns the tickets in any selected status (order preserved)', () => {
    expect(filterBySelection(tickets, ['running', 'failed']).map((t) => t.id)).toEqual([1, 3]);
  });

  it('archived yields nothing here (sourced separately)', () => {
    expect(filterBySelection(tickets, ['archived'])).toEqual([]);
  });

  it('counts each facet; all = active total; archived passed in', () => {
    const c = facetCounts(tickets, 5);
    expect(c.all).toBe(4);
    expect(c.running).toBe(1);
    expect(c.input).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.done).toBe(0);
    expect(c.archived).toBe(5);
  });
});

describe('FACETS list', () => {
  it('starts with all, covers the five states, then archived last', () => {
    expect(FACETS.map((f) => f.key)).toEqual(['all', 'running', 'input', 'failed', 'done', 'archived']);
  });
});
