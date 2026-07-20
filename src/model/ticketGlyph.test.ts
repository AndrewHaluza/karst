import { describe, it, expect } from 'vitest';
import type { TicketWithStages } from '../store/tickets.js';
import { ticketGlyph } from './ticketGlyph.js';

function ticket(over: Partial<TicketWithStages>): TicketWithStages {
  return {
    id: 1,
    key: 'KAR-1',
    title: 'T',
    source: null,
    stageCurrent: 'impl',
    agentState: 'idle',
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
    stages: [{ stageKey: 'impl', status: 'running' } as never],
    ...over,
  } as TicketWithStages;
}

describe('ticketGlyph', () => {
  it('waiting agent → amber (needs-you wins)', () => {
    expect(ticketGlyph(ticket({ agentState: 'waiting' }))).toBe('amber');
  });
  it('failed current stage → red', () => {
    expect(
      ticketGlyph(
        ticket({
          stageCurrent: 'impl',
          stages: [{ stageKey: 'impl', status: 'failed' } as never],
        }),
      ),
    ).toBe('red');
  });
  it('running → blue', () => {
    expect(ticketGlyph(ticket({ agentState: 'running' }))).toBe('blue');
  });
  it('pending/idle → gray', () => {
    expect(
      ticketGlyph(
        ticket({
          agentState: 'idle',
          stages: [{ stageKey: 'impl', status: 'pending' } as never],
        }),
      ),
    ).toBe('gray');
  });
});
