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
    updatedAt: null,
    model: null,
    effort: null,
    agentProvider: null,
    sessionProvider: null,
    type: null,
    projectId: null,
    parentTicketId: null,
    stages: stageCurrent
      ? [
          {
            ticketId: 1,
            stageKey: stageCurrent,
            status,
            attempt: 0,
            verdict: null,
            artifactPath: null,
            startedAt: null,
            endedAt: null,
            blockedKind: null,
            blockedReason: null,
            blockedAt: null,
          },
        ]
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

  // The bug this fixes: a ticket parked at ship is waiting on a button click and
  // nothing else. It used to read "Shipping" (blue) because the machine entered
  // ship as running, so "Needs you" was never reached by any ticket.
  it('a ticket parked at ship reads as needs-you', () => {
    const b = stageBadge(ticket('ship', 'pending'));
    expect(b.label).toBe('Needs you');
    expect(b.glyph).toBe('amber');
  });

  it('a ship that is actually running still reads as shipping, not needs-you', () => {
    const b = stageBadge(ticket('ship', 'running'));
    expect(b.label).toBe('Shipping');
    expect(b.glyph).toBe('blue');
  });

  it('a failed ship stays blocked — it reports the failure, not needs-you', () => {
    const b = stageBadge(ticket('ship', 'failed'));
    expect(b.label).toBe('Ship failed');
    expect(b.glyph).toBe('red');
  });

  it('a pending agent-driven stage does not claim to need the user', () => {
    // Only a confirm stage parks on the user; awaiting a gate is not needs-you.
    expect(stageBadge(ticket('review', 'pending')).label).toBe('Awaiting review');
    expect(stageBadge(ticket('review', 'pending')).glyph).not.toBe('amber');
  });

  it('a failed stage names the stage that failed', () => {
    const b = stageBadge(ticket('uat', 'failed'));
    expect(b.label).toBe('UAT failed');
    expect(b.glyph).toBe('red');
  });

  it('the terminal stage reads as done', () => {
    const b = stageBadge(ticket('done', 'passed'));
    expect(b.label).toBe('Done');
    expect(b.glyph).toBe('green');
  });

  it('carries the stage key itself, so the chip can color and name it', () => {
    // The label paraphrases (stage, status, agent); the chip states the stage
    // alone, because status already has the dot on the other side of the row.
    expect(stageBadge(ticket('uat', 'failed')).stage).toBe('uat');
    expect(stageBadge(ticket('impl', 'running', { agentState: 'waiting' })).stage).toBe('impl');
  });

  it('has no stage key when the ticket has not started or the stage left the graph', () => {
    const t = ticket('impl', 'running');
    expect(stageBadge(ticket(null, 'pending')).stage).toBeNull();
    expect(stageBadge({ ...t, stageCurrent: 'legacy-stage' as unknown as StageKey }).stage).toBeNull();
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
