import { describe, it, expect } from 'vitest';
import type { TicketWithStages } from '../store/tickets.js';
import { needsUser, ticketGlyph } from './ticketGlyph.js';

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
  it('parked at a confirm stage → amber, with no agent involved at all', () => {
    // No session runs at ship, so no hook can ever set agentState='waiting'.
    // The stage itself is the needs-you signal.
    expect(
      ticketGlyph(
        ticket({
          stageCurrent: 'ship',
          agentState: 'idle',
          stages: [{ stageKey: 'ship', status: 'pending' } as never],
        }),
      ),
    ).toBe('amber');
  });

  it('a confirm stage actually running → blue, not amber', () => {
    expect(
      ticketGlyph(
        ticket({
          stageCurrent: 'ship',
          agentState: 'idle',
          stages: [{ stageKey: 'ship', status: 'running' } as never],
        }),
      ),
    ).toBe('blue');
  });

  it('a waiting agent at a RUNNING ship is not a needs-you — ship is the driver’s work', () => {
    // The hook that set 'waiting' fired inside ship's own headless run: the
    // ticket is moving, not parked, so neither the derivation nor the glyph
    // may read it as blocked on the user (869ed7bpd).
    const t = ticket({
      stageCurrent: 'ship',
      agentState: 'waiting',
      stages: [{ stageKey: 'ship', status: 'running' } as never],
    });
    expect(needsUser(t)).toBe(false);
    expect(ticketGlyph(t)).toBe('blue');
  });

  it('a graph impl stage awaiting the impl marker reads needs-you, amber — the same way approach-graph-failed does', () => {
    // The graph run is done but nothing advances until a human or agent fires
    // `karst stage impl pass`; the stage row itself stays `running` (the
    // driver never re-infers a verdict), so the needs-you signal has to come
    // from the blockedKind, exactly like `approach-graph-failed`.
    const t = ticket({
      stageCurrent: 'impl',
      agentState: 'idle',
      stages: [
        {
          stageKey: 'impl',
          status: 'running',
          blockedKind: 'awaiting-impl-marker',
          blockedReason: 'graph run 7 completed-awaiting-impl-marker',
          blockedAt: '2026-08-01T10:00:00.000Z',
        } as never,
      ],
    });
    expect(needsUser(t)).toBe(true);
    expect(ticketGlyph(t)).toBe('amber');
  });

  it('a running agent at an awaiting-merge ship reads in-progress, not needs-you', () => {
    // The "Resolve conflicts" click opened a session: the ticket is being
    // worked right now, so the awaiting-merge block YIELDS its needs-you
    // reading while the agent runs. The block itself stays stored —
    // `settleShipGate` needs it to tell "waiting to land" from "parked" — only
    // the READING changes.
    const t = ticket({
      stageCurrent: 'ship',
      agentState: 'running',
      stages: [
        {
          stageKey: 'ship',
          status: 'passed',
          blockedKind: 'awaiting-merge',
          blockedReason: 'blocked: the pull request for "api" is not merged yet',
          blockedAt: '2026-08-01T10:00:00.000Z',
        } as never,
      ],
    });
    expect(needsUser(t)).toBe(false);
    expect(ticketGlyph(t)).toBe('blue');
  });

  it('an awaiting-merge ship reads needs-you again once the resolve session ends', () => {
    // SessionEnd → idle: nobody is working the ticket, so the wait for a human
    // merge click resumes. The fix must not erase the wait, only pause it.
    const t = ticket({
      stageCurrent: 'ship',
      agentState: 'idle',
      stages: [
        {
          stageKey: 'ship',
          status: 'passed',
          blockedKind: 'awaiting-merge',
          blockedReason: 'blocked: the pull request for "api" is not merged yet',
          blockedAt: '2026-08-01T10:00:00.000Z',
        } as never,
      ],
    });
    expect(needsUser(t)).toBe(true);
    expect(ticketGlyph(t)).toBe('amber');
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
