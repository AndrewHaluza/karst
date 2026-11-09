// @vitest-environment jsdom
/**
 * The ticket-form Relations card renders the shared `.k-ticket-ref` chip from
 * the structured view the host pushes. The state crosses postMessage, so the
 * webview must build nodes — never parse the state as HTML (CodeQL
 * js/xss-through-dom).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderWebview, type RenderHandle } from '../testing/renderHarness.js';
import { ticketRefView, renderTicketRefHtml } from '../shared/ticketRefView.js';
import type { TicketWithStages } from '../../store/tickets.js';

function ticket(overrides: Partial<TicketWithStages> = {}): TicketWithStages {
  return {
    id: 963,
    key: 'FIX-101',
    title: 'Blocker',
    stageCurrent: 'impl',
    archivedAt: null,
    agentState: 'none',
    stages: [],
    ...overrides,
  } as TicketWithStages;
}

function baseState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'edit', provider: 'manual', title: 'Ticket', key: 'T-1', description: '',
    repos: [], approaches: [], agents: [], unclassified: [], attachments: [],
    ...over,
  };
}

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

function open(state: Record<string, unknown>): RenderHandle {
  h = renderWebview('ticketForm');
  h.receive({ type: 'state', state });
  return h;
}

function relation(refView: ReturnType<typeof ticketRefView>) {
  return {
    id: 1,
    kind: 'blocked-by',
    kindLabel: 'Blocked by',
    ticketId: refView.ticketId,
    label: refView.label,
    writebackError: null,
    refView,
  };
}

describe('ticket form — relations card', () => {
  it('shows the Relations heading, not Blocked by', () => {
    const v = open(baseState({ relations: [relation(ticketRefView(ticket()))] }));
    const card = v.query<HTMLElement>('#dependenciesCard')!;
    expect(card.hidden).toBe(false);
    expect(card.querySelector('h2')!.textContent).toBe('Relations');
  });

  it('renders the shared ticket reference chip with id, key, stage and a link on the id', () => {
    const refView = ticketRefView(ticket());
    const v = open(baseState({ relations: [relation(refView)] }));
    const chip = v.query('#dependenciesList .k-ticket-ref')!;

    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe('T963 · FIX-101 · impl');
    expect(chip.querySelector('.k-ticket-ref-dot')).not.toBeNull();
    expect(chip.getAttribute('aria-label')).toBe(refView.accessibleName);

    const link = chip.querySelector('a')!;
    expect(link.textContent).toBe('T963');
    expect(link.getAttribute('data-act')).toBe('open-dependency');
    expect(link.getAttribute('data-id')).toBe('963');
  });

  it('matches the React/string renderer text and accessible name', () => {
    const refView = ticketRefView(ticket());
    const v = open(baseState({ relations: [relation(refView)] }));
    const chip = v.query('#dependenciesList .k-ticket-ref') as HTMLElement;

    const div = v.document.createElement('div');
    div.innerHTML = renderTicketRefHtml(refView, { link: true, dataIdAttr: 'data-id' });
    const expected = div.firstElementChild as HTMLElement;

    expect(chip.textContent).toBe(expected.textContent);
    expect(chip.getAttribute('aria-label')).toBe(expected.getAttribute('aria-label'));
    expect(chip.className).toBe(expected.className);
  });

  it('never parses the pushed view as HTML', () => {
    const refView = {
      ...ticketRefView({ ref: '<img src=x onerror="window.__pwned=1">' }),
      accessibleName: '<b>not markup</b>',
    };
    const v = open(baseState({ relations: [relation(refView)] }));
    const chip = v.query('#dependenciesList .k-ticket-ref')!;

    expect(chip.querySelector('img')).toBeNull();
    expect(chip.querySelector('b')).toBeNull();
    expect(chip.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect((v.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
