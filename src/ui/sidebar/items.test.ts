import { describe, it, expect } from 'vitest';
import { buildTicketNodes, filterTickets } from './items.js';
import type { TicketWithStages } from '../../store/tickets.js';

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
    stages: [
      { ticketId: 1, stageKey: 'scope', status: 'passed', attempt: 0, verdict: 'passed', artifactPath: null, startedAt: null, endedAt: null },
      { ticketId: 1, stageKey: 'impl', status: 'running', attempt: 0, verdict: null, artifactPath: null, startedAt: null, endedAt: null },
    ],
    ...over,
  };
}

describe('buildTicketNodes', () => {
  it('maps each ticket to a collapsible ticket node with label from key + title', () => {
    const nodes = buildTicketNodes([ticket()]);
    expect(nodes).toHaveLength(1);
    const n = nodes[0]!;
    expect(n.kind).toBe('ticket');
    expect(n.ticketId).toBe(1);
    expect(n.label).toContain('PROJ-1');
    expect(n.label).toContain('a thing');
    expect(n.collapsible).toBe(true);
  });

  it('carries the current stage as the node description (visible when folded)', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: 'impl' })])[0]!;
    expect(n.description).toContain('impl');
  });

  it('shows (none) in the description when no current stage', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: null })])[0]!;
    expect(n.description).toContain('none');
  });

  it('glyph reflects current stage status + agent state (running impl => blue)', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: 'impl', agentState: 'none' })])[0]!;
    expect(n.glyph).toBe('blue');
  });

  it('waiting agent wins => amber regardless of stage', () => {
    const n = buildTicketNodes([
      ticket({ stageCurrent: 'scope', agentState: 'waiting' }),
    ])[0]!;
    expect(n.glyph).toBe('amber');
  });

  it('failed current stage => red; passed => green; unknown current => gray', () => {
    const failed = buildTicketNodes([
      ticket({ stageCurrent: 'scope', agentState: 'none', stages: [
        { ticketId: 1, stageKey: 'scope', status: 'failed', attempt: 0, verdict: 'failed', artifactPath: null, startedAt: null, endedAt: null },
      ] }),
    ])[0]!;
    expect(failed.glyph).toBe('red');

    const passed = buildTicketNodes([
      ticket({ stageCurrent: 'scope', agentState: 'none', stages: [
        { ticketId: 1, stageKey: 'scope', status: 'passed', attempt: 0, verdict: 'passed', artifactPath: null, startedAt: null, endedAt: null },
      ] }),
    ])[0]!;
    expect(passed.glyph).toBe('green');

    const unknown = buildTicketNodes([
      ticket({ stageCurrent: null, agentState: 'none' }),
    ])[0]!;
    expect(unknown.glyph).toBe('gray');
  });
});

describe('filterTickets', () => {
  const tickets = [
    ticket({ id: 1, key: 'PROJ-1', title: 'add login' }),
    ticket({ id: 2, key: 'PROJ-2', title: 'fix logout' }),
  ];

  it('empty query returns all', () => {
    expect(filterTickets(tickets, '')).toHaveLength(2);
    expect(filterTickets(tickets, '  ')).toHaveLength(2);
  });

  it('matches on key or title, case-insensitive', () => {
    expect(filterTickets(tickets, 'proj-2').map((t) => t.id)).toEqual([2]);
    expect(filterTickets(tickets, 'LOGIN').map((t) => t.id)).toEqual([1]);
    expect(filterTickets(tickets, 'log').map((t) => t.id)).toEqual([1, 2]);
  });
});
