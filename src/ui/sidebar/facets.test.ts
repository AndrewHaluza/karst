import { describe, it, expect } from 'vitest';
import { facetOf, matchesFacet, filterByFacet, facetCounts, FACETS } from './facets.js';
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
    model: null,
    projectId: null,
    stages: [
      { ticketId: 1, stageKey: 'impl', status: 'running', attempt: 0, verdict: null, artifactPath: null, startedAt: null, endedAt: null },
    ],
    ...over,
  };
}

const stage = (key: StageKey, status: TicketWithStages['stages'][number]['status']) => ({
  ticketId: 1, stageKey: key, status, attempt: 0, verdict: null, artifactPath: null, startedAt: null, endedAt: null,
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
});

describe('matchesFacet', () => {
  const running = ticket({ stageCurrent: 'impl', stages: [stage('impl', 'running')] });
  it('all matches everything', () => {
    expect(matchesFacet(running, 'all')).toBe(true);
    expect(matchesFacet(ticket({ stageCurrent: 'scope', stages: [stage('scope', 'pending')] }), 'all')).toBe(true);
  });
  it('a facet matches only its own tickets', () => {
    expect(matchesFacet(running, 'running')).toBe(true);
    expect(matchesFacet(running, 'failed')).toBe(false);
  });
});

describe('filterByFacet + facetCounts', () => {
  const tickets = [
    ticket({ id: 1, stageCurrent: 'impl', stages: [stage('impl', 'running')] }),       // running
    ticket({ id: 2, agentState: 'waiting', stageCurrent: 'scope', stages: [stage('scope', 'pending')] }), // input
    ticket({ id: 3, stageCurrent: 'uat', stages: [stage('uat', 'failed')] }),           // failed
    ticket({ id: 4, stageCurrent: 'scope', stages: [stage('scope', 'pending')] }),      // none
  ];

  it('filters to the facet, all returns everything', () => {
    expect(filterByFacet(tickets, 'all')).toHaveLength(4);
    expect(filterByFacet(tickets, 'running').map((t) => t.id)).toEqual([1]);
    expect(filterByFacet(tickets, 'input').map((t) => t.id)).toEqual([2]);
    expect(filterByFacet(tickets, 'failed').map((t) => t.id)).toEqual([3]);
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
