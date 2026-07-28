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
    agentProvider: null,
    sessionProvider: null,
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

  it('activityLabel reflects the agent/session runtime state', () => {
    expect(buildTicketNodes([ticket({ agentState: 'running' })])[0]!.activityLabel).toBe('Agent running');
    expect(buildTicketNodes([ticket({ agentState: 'waiting' })])[0]!.activityLabel).toBe('Agent waiting for input');
    expect(buildTicketNodes([ticket({ agentState: 'idle' })])[0]!.activityLabel).toBe('Session idle');
    expect(buildTicketNodes([ticket({ agentState: 'none' })])[0]!.activityLabel).toBe('No active session');
    expect(buildTicketNodes([ticket({ agentState: null })])[0]!.activityLabel).toBe('No active session');
  });

  it('sessionAction reads Continue for a captured interactive session, Start otherwise', () => {
    // Interrupted impl/fix with a captured id → the button continues in place.
    expect(
      buildTicketNodes([
        ticket({ sessionId: 'sid', sessionProvider: 'claude', stageCurrent: 'impl' }),
      ], undefined, 'claude')[0]!.sessionAction,
    ).toEqual({ kind: 'continue', label: 'Continue', detail: 'resume impl' });
    // Captured under a different core → resuming it would die, so re-seed.
    expect(
      buildTicketNodes([
        ticket({ sessionId: 'sid', sessionProvider: 'codex', stageCurrent: 'impl' }),
      ], undefined, 'claude')[0]!.sessionAction,
    ).toEqual({ kind: 'start', label: 'Start', detail: 're-seed from context' });
    // Drafted, never run (no id) → the button starts a fresh session.
    expect(
      buildTicketNodes([ticket({ sessionId: null, stageCurrent: 'scope' })])[0]!.sessionAction,
    ).toEqual({ kind: 'start', label: 'Start', detail: 'fresh session' });
  });

  it('lastActiveAt is the current stage endedAt, else startedAt, else null', () => {
    const ended = buildTicketNodes([
      ticket({
        stageCurrent: 'impl',
        stages: [
          { ticketId: 1, stageKey: 'impl', status: 'passed', attempt: 0, verdict: 'passed', artifactPath: null, startedAt: '2026-07-22T10:00:00Z', endedAt: '2026-07-22T10:05:00Z' },
        ],
      }),
    ])[0]!;
    expect(ended.lastActiveAt).toBe('2026-07-22T10:05:00Z');

    const started = buildTicketNodes([
      ticket({
        stageCurrent: 'impl',
        stages: [
          { ticketId: 1, stageKey: 'impl', status: 'running', attempt: 0, verdict: null, artifactPath: null, startedAt: '2026-07-22T10:00:00Z', endedAt: null },
        ],
      }),
    ])[0]!;
    expect(started.lastActiveAt).toBe('2026-07-22T10:00:00Z');

    const none = buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!;
    expect(none.lastActiveAt).toBeNull();
  });

  it('passes the ticket model through', () => {
    const n = buildTicketNodes([ticket({ model: 'claude-opus-4-8' })])[0]!;
    expect(n.model).toBe('claude-opus-4-8');
  });

  it('blocker carries the failure reason + attempt when the current stage failed', () => {
    const n = buildTicketNodes([
      ticket({
        stageCurrent: 'uat',
        stages: [
          { ticketId: 1, stageKey: 'uat', status: 'failed', attempt: 2, verdict: '2 tests red', artifactPath: null, startedAt: null, endedAt: null },
        ],
      }),
    ])[0]!;
    expect(n.blocker).toEqual({ reason: '2 tests red', attempt: 2 });
  });

  it('blocker reason is null (line still shows the attempt) when a failed stage has no verdict', () => {
    const n = buildTicketNodes([
      ticket({
        stageCurrent: 'uat',
        stages: [
          { ticketId: 1, stageKey: 'uat', status: 'failed', attempt: 3, verdict: null, artifactPath: null, startedAt: null, endedAt: null },
        ],
      }),
    ])[0]!;
    expect(n.blocker).toEqual({ reason: null, attempt: 3 });
  });

  it('blocker is null for a non-failed stage — status is the row glyph, never duplicated here', () => {
    // shared default: impl running.
    expect(buildTicketNodes([ticket()])[0]!.blocker).toBeNull();
    // needs-you / awaiting / not-started are all just the glyph color too.
    expect(buildTicketNodes([ticket({ agentState: 'waiting' })])[0]!.blocker).toBeNull();
    expect(buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!.blocker).toBeNull();
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
