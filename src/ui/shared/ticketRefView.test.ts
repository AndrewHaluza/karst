import { describe, it, expect } from 'vitest';
import { ticketRefView, formatTicketRefText, renderTicketRefHtml } from './ticketRefView.js';
import type { TicketWithStages } from '../../store/tickets.js';

function mockTicket(overrides: Partial<TicketWithStages> = {}): TicketWithStages {
  const stageCurrent = overrides.stageCurrent ?? 'impl';
  const stageStatus = stageCurrent === 'done' ? 'passed' : 'running';
  return {
    id: 963,
    key: 'FIX-101',
    title: 'Fix ticket reference chip',
    stageCurrent,
    archivedAt: null,
    agentState: 'none',
    stages: [
      {
        id: 1,
        ticketId: overrides.id ?? 963,
        stageKey: stageCurrent,
        status: stageStatus,
        attempt: 1,
        verdict: null,
        startedAt: '2026-11-08T00:00:00.000Z',
        endedAt: null,
      },
    ],
    ...overrides,
  } as TicketWithStages;
}

describe('ticketRefView', () => {
  it('builds view for an in-progress ticket target (kind: ticket)', () => {
    const t = mockTicket({ id: 963, key: 'FIX-101', stageCurrent: 'impl' });
    const view = ticketRefView(t);

    expect(view.kind).toBe('ticket');
    expect(view.ticketId).toBe(963);
    expect(view.idLabel).toBe('T963');
    expect(view.keyOrRef).toBe('FIX-101');
    expect(view.stage).toBe('impl');
    expect(view.glyph).toBe('blue');
    expect(view.displayTextParts).toEqual({
      id: 'T963',
      key: 'FIX-101',
      stage: 'impl',
    });
    expect(view.accessibleName).toBe('Ticket T963 in impl');
    expect(formatTicketRefText(view, { prefix: 'Blocked by ' })).toBe('Blocked by ● T963 · FIX-101 · impl');
    expect(formatTicketRefText(view, { prefix: 'Blocked by ', showKey: false })).toBe('Blocked by ● T963 · impl');
  });

  it('builds view for a finished target at done (kind: finished)', () => {
    const t = mockTicket({ id: 970, key: 'FEAT-200', stageCurrent: 'done' });
    const view = ticketRefView(t);

    expect(view.kind).toBe('finished');
    expect(view.ticketId).toBe(970);
    expect(view.idLabel).toBe('T970');
    expect(view.keyOrRef).toBe('FEAT-200');
    expect(view.stage).toBe('done');
    expect(view.glyph).toBe('green');
    expect(view.displayTextParts).toEqual({
      id: 'T970',
      key: 'FEAT-200',
      stage: 'done',
    });
    expect(view.accessibleName).toBe('Ticket T970 done');
  });

  it('builds view for a finished target at closed (kind: finished)', () => {
    const t = mockTicket({ id: 971, key: 'FEAT-201', stageCurrent: 'closed' });
    const view = ticketRefView(t);

    expect(view.kind).toBe('finished');
    expect(view.ticketId).toBe(971);
    expect(view.idLabel).toBe('T971');
    expect(view.keyOrRef).toBe('FEAT-201');
    expect(view.stage).toBe('closed');
    expect(view.glyph).toBe('gray');
    expect(view.displayTextParts).toEqual({
      id: 'T971',
      key: 'FEAT-201',
      stage: 'closed',
    });
    expect(view.accessibleName).toBe('Ticket T971 closed');
  });

  it('builds view for a pending planning draft (kind: draft)', () => {
    const view = ticketRefView({ draftId: 445 });

    expect(view.kind).toBe('draft');
    expect(view.ticketId).toBeNull();
    expect(view.idLabel).toBe('D445');
    expect(view.keyOrRef).toBeNull();
    expect(view.stage).toBeNull();
    expect(view.glyph).toBe('gray');
    expect(view.displayTextParts).toEqual({
      id: 'D445',
      key: null,
      stage: null,
    });
    expect(view.accessibleName).toBe('D445, draft pending');
    expect(formatTicketRefText(view)).toBe('● D445');
  });

  it('builds view for an accepted draft ticket in review (kind: ticket)', () => {
    const t = mockTicket({ id: 970, key: 'FEAT-200', stageCurrent: 'review' });
    const view = ticketRefView({ draftId: 445, ticket: t });

    expect(view.kind).toBe('ticket');
    expect(view.ticketId).toBe(970);
    expect(view.idLabel).toBe('D445→T970');
    expect(view.keyOrRef).toBe('FEAT-200');
    expect(view.stage).toBe('review');
    expect(view.displayTextParts).toEqual({
      id: 'D445→T970',
      key: null,
      stage: 'review',
    });
    expect(view.accessibleName).toBe('D445, ticket T970 in review');
    expect(formatTicketRefText(view)).toBe('● D445→T970 · review');
  });

  it('builds view for an accepted draft ticket in done (kind: finished with stage word)', () => {
    const t = mockTicket({ id: 970, key: 'FEAT-200', stageCurrent: 'done' });
    const view = ticketRefView({ draftId: 445, ticket: t });

    expect(view.kind).toBe('finished');
    expect(view.ticketId).toBe(970);
    expect(view.idLabel).toBe('D445→T970');
    expect(view.stage).toBe('done');
    expect(view.glyph).toBe('green');
    expect(view.displayTextParts).toEqual({
      id: 'D445→T970',
      key: null,
      stage: 'done',
    });
    expect(view.accessibleName).toBe('D445, ticket T970 done');
    expect(formatTicketRefText(view)).toBe('● D445→T970 · done');
  });

  it('builds view for a dangling provider ref (kind: ref)', () => {
    const view = ticketRefView({ ref: 'ABC-123' });

    expect(view.kind).toBe('ref');
    expect(view.ticketId).toBeNull();
    expect(view.idLabel).toBeNull();
    expect(view.keyOrRef).toBe('ABC-123');
    expect(view.stage).toBeNull();
    expect(view.glyph).toBe('gray');
    expect(view.displayTextParts).toEqual({
      id: 'ABC-123',
      key: null,
      stage: null,
    });
    expect(view.accessibleName).toBe('ABC-123');
    expect(formatTicketRefText(view, { prefix: 'Blocked by ' })).toBe('Blocked by ● ABC-123');
  });

  it('renders HTML string with identical text and structure', () => {
    const t = mockTicket({ id: 963, key: 'KEY', stageCurrent: 'impl' });
    const view = ticketRefView(t);
    const html = renderTicketRefHtml(view, { prefix: 'Blocked by ' });

    expect(html).toContain('class="k-ticket-ref"');
    expect(html).toContain('class="k-ticket-ref-dot g-blue"');
    expect(html).toContain('Blocked by ');
    expect(html).toContain('<a href="#" data-act="open-dependency" data-ticket="963">T963</a>');
    expect(html).toContain(' · KEY · impl');
    expect(html).toContain('aria-label="Ticket T963 in impl"');
  });
});
