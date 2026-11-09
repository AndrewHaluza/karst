// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { DashboardState } from '../state.js';
import { renderBrief } from '../../../integrations/briefMarkdown.js';
import { mountOverlays, must, q, text } from './fixtures/overlaysKit.js';

const state = (over: Record<string, unknown> = {}): DashboardState =>
  ({
    ticketId: 7, idLabel: 'T7', key: 'FEAT-7', title: 'Seven', brief: '', description: '', provider: null, ticketUrl: null,
    briefSource: { kind: 'manual' }, origin: null, subtaskParent: null, priority: null, approach: null, worktrees: [], ...over,
  }) as unknown as DashboardState;
const drawer = (): HTMLElement => must('#ticketDataDrawer');
const isOpen = (): boolean => drawer().classList.contains('open');
const fetched = renderBrief({
  title: 'Seven', description: 'Body **bold** <b>x</b> [bad](javascript:alert(1))', tags: ['bug'], status: 'open',
  comments: [{ author: 'Ada', text: 'hi', date: '' }], attachments: [{ name: 'a.png', size: '2 KB', url: 'https://x/a.png' } as never],
  people: [{ role: 'assignee', name: 'Ada' }],
});
const open = (s: DashboardState) => {
  const h = mountOverlays(s);
  h.act(() => h.overlays.openTicketData());
  return h;
};

describe('TicketDataDrawer', () => {
  it('starts closed: hidden from assistive tech, scrim inert, body empty', () => {
    mountOverlays(state());
    expect(isOpen()).toBe(false);
    expect(drawer().getAttribute('aria-hidden')).toBe('true');
    expect(must('#ticketDataScrim').classList.contains('open')).toBe(false);
    expect(text('#ticketDataBody')).toBe('');
    expect(drawer().getAttribute('role')).toBe('dialog');
    expect(drawer().getAttribute('aria-modal')).toBe('true');
    expect(drawer().getAttribute('aria-labelledby')).toBe('ticketDataTitle');
  });

  it('opens with focus on Close, posts nothing and renders the brief as elements, never HTML', () => {
    const h = open(state({ brief: fetched, briefSource: { kind: 'provider', provider: 'jira' }, provider: 'jira' }));
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(must('#ticketDataClose'));
    expect(text('#ticketDataTitle')).toBe('Seven');
    expect(q('#ticketDataBody b')).toBeNull();
    expect(text('#ticketDataBody')).toContain('<b>x</b>');
    expect(q('#ticketDataBody a[href^="javascript"]')).toBeNull();
    expect(text('#ticketDataBody')).toContain('Comments · 1');
    expect(text('#ticketDataBody')).toContain('Attachments · 1');
    expect(text('.tdSource')).toBe('from Jira');
    expect(Object.values(h.send).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it('shows Brief, As sent to agent and no Original tab when description equals the brief body', () => {
    open(state({ brief: fetched, description: 'Body' }));
    const labels = [...document.querySelectorAll('[role=tab]')].map((t) => t.textContent);
    expect(labels).toContain('Brief');
    expect(labels).toContain('As sent to agent');
  });

  it('shows the raw agent text verbatim in the third tab, with the hint', () => {
    open(state({ brief: 'plain brief' }));
    fireEvent.click(must('#tdTab-raw'));
    expect(must('.tdRaw').textContent).toBe('plain brief');
    expect(text('.tdHint')).toBe("exact Markdown in the agent's launch context");
  });

  it('moves between tabs with the arrow keys', () => {
    open(state({ brief: fetched, description: 'Original text' }));
    const tabs = must('[role=tablist]');
    expect(must('#tdTab-brief').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tabs, { key: 'ArrowRight' });
    expect(must('#tdTab-desc').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tabs, { key: 'ArrowLeft' });
    expect(must('#tdTab-brief').getAttribute('aria-selected')).toBe('true');
  });

  it('shows a description-only ticket as Description and the empty text when there is nothing', () => {
    open(state({ description: 'Fix the login modal' }));
    expect(text('#tdTab-brief')).toBe('Description');
    expect(text('#ticketDataBody')).toContain('Fix the login modal');
  });

  it('shows the empty text and no tabs without a brief or description', () => {
    open(state());
    expect(text('#ticketDataBody')).toBe('No brief or description yet. Add one in the ticket form, or link a ticket from your tracker.');
    expect(q('[role=tablist]')).toBeNull();
  });

  it('posts the exact agent text for Copy and Open as Markdown, and edit-ticket', () => {
    const h = open(state({ brief: 'plain brief' }));
    fireEvent.click(must('[data-act="copy-ticket-markdown"]'));
    fireEvent.click(must('[data-act="open-ticket-markdown"]'));
    expect(h.send.copyTicketMarkdown.mock.calls[0]?.[0]).toBe('plain brief');
    expect(h.send.openTicketMarkdown.mock.calls[0]?.[0]).toBe('plain brief');
    fireEvent.click(must('[data-act="edit-ticket"]'));
    expect(h.send.editTicket).toHaveBeenCalledTimes(1);
  });

  it('shows the provider chip as a link when there is a ticket URL, else a text chip', () => {
    open(state({ brief: 'b', provider: 'jira', ticketUrl: 'https://x/t' }));
    expect(must('[data-act="open-ticket-link"]').textContent).toBe('Jira ↗');
  });

  it('shows the karst ticket chip with no provider', () => {
    open(state({ brief: 'b' }));
    expect(text('.tdProvider')).toBe('karst ticket');
  });

  it('closes on the close button and on the scrim, returning focus to the trigger', () => {
    const h = mountOverlays(state({ brief: 'b' }));
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    h.act(() => h.overlays.openTicketData());
    fireEvent.click(must('#ticketDataClose'));
    expect(isOpen()).toBe(false);
    expect(drawer().getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(trigger);

    h.act(() => h.overlays.openTicketData());
    fireEvent.click(must('#ticketDataScrim'));
    expect(isOpen()).toBe(false);
  });

  it('keeps the first view while open and does not follow later pushes', () => {
    const h = open(state({ brief: 'first' }));
    h.emit({ type: 'state', state: state({ brief: 'second' }) });
    fireEvent.click(must('#tdTab-raw'));
    expect(must('.tdRaw').textContent).toBe('first');
  });
});
