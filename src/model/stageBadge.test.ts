import { describe, it, expect } from 'vitest';
import { stageBadge, STAGE_TITLE } from './stageBadge.js';
import type { TicketWithStages } from '../store/tickets.js';
import type { StageKey, StageStatus } from './types.js';

function ticket(
  stageCurrent: StageKey | null,
  status: StageStatus,
  over: Partial<TicketWithStages> = {},
): TicketWithStages {
  return {
    id: 1,
    key: 'PROJ-1',
    title: 'a thing',
    source: 'manual',
    stageCurrent,
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
    stages: stageCurrent
      ? [{ ticketId: 1, stageKey: stageCurrent, status, attempt: 0, verdict: null, artifactPath: null, startedAt: null, endedAt: null }]
      : [],
    ...over,
  };
}

describe('stageBadge', () => {
  it('names every stage', () => {
    expect(STAGE_TITLE.uat).toBe('UAT');
    expect(STAGE_TITLE.impl).toBe('Implementation');
  });

  it('running stages read as an activity', () => {
    expect(stageBadge(ticket('impl', 'running')).label).toBe('Implementing');
    expect(stageBadge(ticket('uat', 'running')).label).toBe('Validating');
    expect(stageBadge(ticket('review', 'running')).label).toBe('Reviewing');
  });

  it('a waiting agent wins over stage state (needs-you)', () => {
    const b = stageBadge(ticket('impl', 'running', { agentState: 'waiting' }));
    expect(b.label).toBe('Needs you');
    expect(b.glyph).toBe('amber');
  });

  it('a failed stage names the stage that failed', () => {
    const b = stageBadge(ticket('uat', 'failed'));
    expect(b.label).toBe('UAT failed');
    expect(b.glyph).toBe('red');
  });

  it('the terminal stage reads as shipped', () => {
    const b = stageBadge(ticket('done', 'passed'));
    expect(b.label).toBe('Shipped');
    expect(b.glyph).toBe('green');
  });

  it('pending stages read as awaiting, with scope spelled out', () => {
    expect(stageBadge(ticket('scope', 'pending')).label).toBe('Not scoped');
    expect(stageBadge(ticket('review', 'pending')).label).toBe('Awaiting review');
  });

  it('a passed non-terminal stage names the stage that passed', () => {
    expect(stageBadge(ticket('impl', 'passed')).label).toBe('Implementation passed');
  });

  it('a skipped stage says so', () => {
    expect(stageBadge(ticket('ship', 'skipped')).label).toBe('Ship skipped');
  });

  it('falls back to Not started when the ticket has no current stage', () => {
    const b = stageBadge(ticket(null, 'pending'));
    expect(b.label).toBe('Not started');
    expect(b.glyph).toBe('gray');
  });

  it('treats a stored stage outside the graph as none, not as a title lookup', () => {
    const t = ticket('impl', 'running');
    const b = stageBadge({ ...t, stageCurrent: 'legacy-stage' as unknown as StageKey });
    expect(b.label).toBe('Not started');
  });

  it('falls back to pending when the current stage has no row', () => {
    const b = stageBadge(ticket('impl', 'running', { stages: [] }));
    expect(b.label).toBe('Awaiting implementation');
    expect(b.glyph).toBe('gray');
  });
});
