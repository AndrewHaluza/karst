// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TicketRefChip } from './TicketRefChip.js';
import { ticketRefView, renderTicketRefHtml, type TicketRefKind } from './ticketRefView.js';
import type { TicketWithStages } from '../../store/tickets.js';

function mockTicket(overrides: Partial<TicketWithStages> = {}): TicketWithStages {
  const stageCurrent = overrides.stageCurrent ?? 'impl';
  const stageStatus = stageCurrent === 'done' ? 'passed' : 'running';
  return {
    id: 963,
    key: 'FIX-101',
    title: 'Test ticket',
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

describe('TicketRefChip', () => {
  it('renders link on id part for ticket reference', () => {
    const view = ticketRefView(mockTicket({ id: 963, key: 'KEY', stageCurrent: 'impl' }));
    const { container } = render(<TicketRefChip refView={view} link prefix="Blocked by " />);

    const chip = container.querySelector('.k-ticket-ref')!;
    expect(chip).not.toBeNull();
    expect(chip.querySelector('.k-ticket-ref-dot')).not.toBeNull();
    expect(chip.textContent).toBe('Blocked by T963 · KEY · impl');

    const link = chip.querySelector('a')!;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe('T963');
    expect(link.getAttribute('data-act')).toBe('open-dependency');
    expect(link.getAttribute('data-ticket')).toBe('963');
  });

  it('renders plain text when link={false}', () => {
    const view = ticketRefView(mockTicket({ id: 963, key: 'KEY', stageCurrent: 'impl' }));
    const { container } = render(<TicketRefChip refView={view} link={false} prefix="Blocked by " showKey={false} />);

    const chip = container.querySelector('.k-ticket-ref')!;
    expect(chip.querySelector('.k-ticket-ref-dot')).not.toBeNull();
    expect(chip.textContent).toBe('Blocked by T963 · impl');
    expect(chip.querySelector('a')).toBeNull();
    expect(chip.getAttribute('title')).toBe('KEY');
  });

  it('renders button link for planning draft dependency', () => {
    const t = mockTicket({ id: 970, key: 'FEAT-200', stageCurrent: 'done' });
    const view = ticketRefView({ draftId: 445, ticket: t });
    const { container } = render(<TicketRefChip refView={view} linkTarget="chip" dataAct="open-dashboard" />);

    const btn = container.querySelector('button.k-ticket-ref')!;
    expect(btn).not.toBeNull();
    expect(btn.querySelector('.k-ticket-ref-dot')).not.toBeNull();
    expect(btn.textContent).toBe('D445→T970 · done');
    expect(btn.getAttribute('data-act')).toBe('open-dashboard');
    expect(btn.getAttribute('data-id')).toBe('970');
    expect(btn.getAttribute('aria-label')).toBe('D445, ticket T970 done');
  });

  it('renders a plain chip for a draft blocker when link={false}, never a nested button', () => {
    const view = ticketRefView({ draftId: 445 });
    const { container } = render(<TicketRefChip refView={view} link={false} prefix="Blocked by " />);

    const chip = container.querySelector('.k-ticket-ref')!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.querySelector('button')).toBeNull();
    expect(chip.querySelector('a')).toBeNull();
    expect(chip.textContent).toBe('Blocked by D445');
  });

  it('renders a draft-origin ticket blocker as plain text inside the row click target', () => {
    const t = mockTicket({ id: 970, key: 'FEAT-200', stageCurrent: 'impl' });
    const view = ticketRefView({ draftId: 445, ticket: t });
    const { container } = render(<TicketRefChip refView={view} link={false} prefix="Blocked by " showKey={false} />);

    const chip = container.querySelector('.k-ticket-ref')!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.querySelector('button')).toBeNull();
    expect(chip.textContent).toBe('Blocked by D445→T970 · impl');
  });

  it('honours prefix when the whole chip is the link', () => {
    const t = mockTicket({ id: 970, key: 'FEAT-200', stageCurrent: 'review' });
    const view = ticketRefView({ draftId: 445, ticket: t });
    const { container } = render(<TicketRefChip refView={view} linkTarget="chip" prefix="needs " dataAct="open-dashboard" />);

    const btn = container.querySelector('button.k-ticket-ref')!;
    expect(btn.textContent).toBe('needs D445→T970 · review');
  });

  it('does not throw for a pre-upgrade snapshot string blocker', () => {
    const view = 'BLOCK-7' as unknown as ReturnType<typeof ticketRefView>;
    const { container } = render(<TicketRefChip refView={view} link={false} prefix="Blocked by " />);

    const chip = container.querySelector('.k-ticket-ref')!;
    expect(chip.textContent).toBe('Blocked by BLOCK-7');
  });

  describe('pre-upgrade planning dependencies', () => {
    it('keeps the draft id and the draft-card action for a pending dep', () => {
      const legacy = {
        id: 94, label: 'D94', kind: 'draft', ticketId: null, ticketLabel: null, stage: null, glyph: 'gray',
      } as unknown as ReturnType<typeof ticketRefView>;
      const { container } = render(<TicketRefChip refView={legacy} linkTarget="chip" dataAct="open-dashboard" />);

      const btn = container.querySelector('button.k-ticket-ref')!;
      expect(btn.getAttribute('data-dep-draft')).toBe('94');
      expect(btn.textContent).toBe('D94');
    });

    it('keeps the D<n>→T<n> id for an accepted dep', () => {
      const legacy = {
        id: 92, label: 'D92', kind: 'ticket', ticketId: 605, ticketLabel: 'T605', stage: 'impl', glyph: 'blue',
      } as unknown as ReturnType<typeof ticketRefView>;
      const { container } = render(<TicketRefChip refView={legacy} linkTarget="chip" dataAct="open-dashboard" />);

      const btn = container.querySelector('button.k-ticket-ref')!;
      expect(btn.textContent).toBe('D92→T605 · impl');
      expect(btn.getAttribute('data-id')).toBe('605');
    });

    it('restores a done accepted dep with the done word', () => {
      const legacy = {
        id: 91, label: 'D91', kind: 'done', ticketId: 604, ticketLabel: 'T604', stage: null, glyph: 'green',
      } as unknown as ReturnType<typeof ticketRefView>;
      const { container } = render(<TicketRefChip refView={legacy} linkTarget="chip" dataAct="open-dashboard" />);

      const btn = container.querySelector('button.k-ticket-ref')!;
      expect(btn.textContent).toBe('D91→T604 · done');
      expect(btn.getAttribute('aria-label')).toBe('D91, ticket T604 done');
    });
  });

  describe('parity between React and HTML string output for each kind (Requirement D)', () => {
    const cases: Array<{ kind: TicketRefKind; name: string; view: ReturnType<typeof ticketRefView> }> = [
      {
        kind: 'ticket',
        name: 'in-progress ticket',
        view: ticketRefView(mockTicket({ id: 963, key: 'KEY-1', stageCurrent: 'impl' })),
      },
      {
        kind: 'finished',
        name: 'finished ticket at done',
        view: ticketRefView(mockTicket({ id: 964, key: 'KEY-2', stageCurrent: 'done' })),
      },
      {
        kind: 'finished',
        name: 'finished ticket at closed',
        view: ticketRefView(mockTicket({ id: 965, key: 'KEY-3', stageCurrent: 'closed' })),
      },
      {
        kind: 'draft',
        name: 'pending draft',
        view: ticketRefView({ draftId: 445 }),
      },
      {
        kind: 'ref',
        name: 'dangling ref',
        view: ticketRefView({ ref: 'EXT-123' }),
      },
    ];

    for (const c of cases) {
      it(`matches text and accessible name for ${c.kind} (${c.name})`, () => {
        const { container } = render(<TicketRefChip refView={c.view} link />);
        const reactEl = container.firstElementChild as HTMLElement;

        const htmlStr = renderTicketRefHtml(c.view, { link: true });
        const div = document.createElement('div');
        div.innerHTML = htmlStr;
        const stringEl = div.firstElementChild as HTMLElement;

        expect(reactEl.textContent?.trim()).toBe(stringEl.textContent?.trim());
        expect(reactEl.getAttribute('aria-label')).toBe(stringEl.getAttribute('aria-label'));
        expect(reactEl.className).toBe(stringEl.className);
      });
    }
  });
});
