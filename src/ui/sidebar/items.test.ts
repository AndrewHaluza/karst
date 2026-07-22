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
    projectId: null,
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

  it('carries the human stage badge every row renders (mock parity)', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: 'impl' })])[0]!;
    expect(n.stageLabel).toBe('Implementing');
  });

  it('falls back to a defined badge when the ticket has no stage', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!;
    expect(n.stageLabel).toBe('Not started');
    expect(n.glyph).toBe('gray');
  });

  it('carries the stage color class the chip renders, matching the dashboard rail', () => {
    expect(buildTicketNodes([ticket({ stageCurrent: 'impl' })])[0]!.stageClass).toBe('stg-impl');
    expect(buildTicketNodes([ticket({ stageCurrent: 'uat' })])[0]!.stageClass).toBe('stg-uat');
  });

  it('a chipped stage key is the key itself (uppercased in the view), and a stageless ticket falls back', () => {
    expect(buildTicketNodes([ticket({ stageCurrent: 'review' })])[0]!.stageChip).toBe('review');
    expect(buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!.stageClass).toBe('stg-unknown');
    expect(buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!.stageChip).toBe('none');
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

  const RAIL_ORDER = ['scope', 'impl', 'uat', 'review', 'ship'] as const;

  it('builds a fixed 5-cell rail in milestone order', () => {
    const n = buildTicketNodes([ticket()])[0]!;
    expect(n.rail.map((c) => c.key)).toEqual([...RAIL_ORDER]);
  });

  it('mirrors each rail cell status from the matching stage row', () => {
    // scope passed, impl running (from the shared builder); the rest default pending.
    const n = buildTicketNodes([ticket()])[0]!;
    const byKey = Object.fromEntries(n.rail.map((c) => [c.key, c.status]));
    expect(byKey.scope).toBe('passed');
    expect(byKey.impl).toBe('running');
    expect(byKey.uat).toBe('pending');
    expect(byKey.review).toBe('pending');
    expect(byKey.ship).toBe('pending');
  });

  it('marks current true only on the current stage cell', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: 'impl' })])[0]!;
    expect(n.rail.filter((c) => c.current).map((c) => c.key)).toEqual(['impl']);
  });

  it('has no current cell when the ticket has no stage', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!;
    expect(n.rail.some((c) => c.current)).toBe(false);
    expect(n.rail.every((c) => c.status === 'pending')).toBe(true);
  });

  it('paints each rail cell with the shared stg-* color token', () => {
    const n = buildTicketNodes([ticket()])[0]!;
    expect(n.rail.find((c) => c.key === 'scope')!.colorClass).toBe('stg-scope');
  });

  it('exposes the current stage failure reason and attempt', () => {
    const n = buildTicketNodes([
      ticket({
        stageCurrent: 'uat',
        stages: [
          { ticketId: 1, stageKey: 'uat', status: 'failed', attempt: 2, verdict: '2 tests red', artifactPath: null, startedAt: null, endedAt: null },
        ],
      }),
    ])[0]!;
    expect(n.reason).toBe('2 tests red');
    expect(n.attempt).toBe(2);
  });

  it('reason is null and attempt 0 when the current stage is missing', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!;
    expect(n.reason).toBeNull();
    expect(n.attempt).toBe(0);
  });

  it('passes the ticket model through', () => {
    const n = buildTicketNodes([ticket({ model: 'claude-opus-4-8' })])[0]!;
    expect(n.model).toBe('claude-opus-4-8');
  });

  it('fix borrows the review rail cell for the current ring', () => {
    const n = buildTicketNodes([
      ticket({
        stageCurrent: 'fix',
        stages: [
          { ticketId: 1, stageKey: 'review', status: 'failed', attempt: 1, verdict: 'changes requested', artifactPath: null, startedAt: null, endedAt: null },
        ],
      }),
    ])[0]!;
    expect(n.rail.filter((c) => c.current).map((c) => c.key)).toEqual(['review']);
  });

  it('done borrows the ship rail cell for the current ring', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: 'done' })])[0]!;
    expect(n.rail.filter((c) => c.current).map((c) => c.key)).toEqual(['ship']);
  });

  it('nextAction: failed current stage with a reason surfaces "<label>: <reason>", warn, attempt', () => {
    const n = buildTicketNodes([
      ticket({
        stageCurrent: 'uat',
        stages: [
          { ticketId: 1, stageKey: 'uat', status: 'failed', attempt: 2, verdict: '2 tests red', artifactPath: null, startedAt: null, endedAt: null },
        ],
      }),
    ])[0]!;
    expect(n.nextAction.text).toBe('UAT failed: 2 tests red');
    expect(n.nextAction.warn).toBe(true);
    expect(n.nextAction.attempt).toBe(2);
  });

  it('nextAction: failed current stage with a null reason falls back to the bare badge label, attempt still shown', () => {
    const n = buildTicketNodes([
      ticket({
        stageCurrent: 'uat',
        stages: [
          { ticketId: 1, stageKey: 'uat', status: 'failed', attempt: 3, verdict: null, artifactPath: null, startedAt: null, endedAt: null },
        ],
      }),
    ])[0]!;
    expect(n.nextAction.text).toBe('UAT failed');
    expect(n.nextAction.warn).toBe(true);
    expect(n.nextAction.attempt).toBe(3);
  });

  it('nextAction: non-failed current stage is the bare badge label, no warn, no attempt', () => {
    const n = buildTicketNodes([ticket()])[0]!; // shared default: stageCurrent 'impl', running
    expect(n.nextAction.text).toBe('Implementing');
    expect(n.nextAction.warn).toBe(false);
    expect(n.nextAction.attempt).toBe(0);
  });

  it('nextAction: no current stage is the bare "Not started" label, no warn, no attempt', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!;
    expect(n.nextAction.text).toBe('Not started');
    expect(n.nextAction.warn).toBe(false);
    expect(n.nextAction.attempt).toBe(0);
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
