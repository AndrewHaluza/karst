// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { DashboardState } from '../state.js';
import { mountOverlays, must, q, text } from './fixtures/overlaysKit.js';

const state = (over: Record<string, unknown> = {}): DashboardState => ({ ticketId: 7, key: 'FEAT-7', title: 'Seven', brief: '', description: '', ...over }) as unknown as DashboardState;
const drawer = (): HTMLElement => must('#ticketDataDrawer');
const isOpen = (): boolean => drawer().classList.contains('open');

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

  it('opens with the brief as TEXT, moves focus into the dialog and posts nothing', () => {
    const h = mountOverlays(state({ brief: '# T\n\n<b>bold</b>' }));
    h.act(() => h.overlays.openTicketData());
    expect(isOpen()).toBe(true);
    expect(must('#ticketDataScrim').classList.contains('open')).toBe(true);
    expect(drawer().getAttribute('aria-hidden')).toBe('false');
    expect(must('#ticketDataBody').textContent).toBe('# T\n\n<b>bold</b>');
    expect(q('#ticketDataBody b')).toBeNull();
    expect(document.activeElement).toBe(must('#ticketDataClose'));
    expect(Object.values(h.send).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it('shows the ticket’s own data when it has no brief', () => {
    const h = mountOverlays(state({ key: 'M-1', title: 'Manual ticket', description: 'Fix the login modal' }));
    h.act(() => h.overlays.openTicketData());
    expect(text('#ticketDataBody')).toBe('# M-1 — Manual ticket\n\nFix the login modal');
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

  it('keeps the last text in the closed drawer and does not follow later pushes while open', () => {
    const h = mountOverlays(state({ brief: 'first' }));
    h.act(() => h.overlays.openTicketData());
    h.emit({ type: 'state', state: state({ brief: 'second' }) });
    expect(text('#ticketDataBody')).toBe('first');
    h.act(() => h.overlays.closeTicketData());
    expect(text('#ticketDataBody')).toBe('first');
  });
});
