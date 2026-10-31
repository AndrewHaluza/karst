// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { $, has, headerState, installHeaderDoubles, mountHeader } from './fixtures/headerKit.js';

installHeaderDoubles();

describe('Header — identity', () => {
  it('paints id, key, title and the provider mark', () => {
    mountHeader(headerState({ provider: 'clickup', priority: ' urgent ', ticketUrl: 'https://x/t' }));
    expect($('#idBadge').textContent).toBe('T7');
    expect($('#keyBtn').textContent).toBe('FEAT-7');
    expect($('#keyBtn').getAttribute('aria-label')).toBe('Copy ticket key FEAT-7');
    expect($('#title').textContent).toBe('Add the thing');
    expect($('#providerMark .provicon')).toBeTruthy();
    expect($('#priorityChip').textContent).toBe('urgent');
    expect($('#priorityChip').getAttribute('aria-label')).toBe('Priority: urgent');
    expect($('#boardLink').hasAttribute('hidden')).toBe(false);
    expect($('#boardLink').getAttribute('data-url')).toBe('https://x/t');
  });

  it('keeps the full identity in title= and the accessible name, with a status chip that never hides', () => {
    mountHeader(headerState({ paused: true }));
    const full = 'T7 · FEAT-7 · Add the thing';
    expect($('.ticketIdentity').getAttribute('title')).toBe(full);
    expect($('.ticketIdentity').getAttribute('aria-label')).toBe(full);
    expect($('#title').getAttribute('title')).toBe(full);
    expect($('#statusChip').textContent).toBe('Paused');
    expect($('#statusChip').hasAttribute('hidden')).toBe(false);
  });

  it('hides the key, priority and board link when the ticket has none, and shows "(untitled)"', () => {
    mountHeader(headerState({ key: null, title: null }));
    expect($('#keyBtn').hasAttribute('hidden')).toBe(true);
    expect($('#priorityChip').hasAttribute('hidden')).toBe(true);
    expect($('#boardLink').hasAttribute('hidden')).toBe(true);
    expect($('#boardLink').hasAttribute('data-url')).toBe(false);
    expect($('#title').textContent).toBe('(untitled)');
  });

  it('copies the key once, runtime-pending, and flashes the confirmation', () => {
    vi.useFakeTimers();
    const h = mountHeader(headerState());
    fireEvent.click($('#keyBtn'));
    fireEvent.click($('#keyBtn'));
    expect(h.send.copyTicketKey).toHaveBeenCalledTimes(1);
    expect(h.send.copyTicketKey).toHaveBeenCalledWith('req-1');
    expect($('#keyBtn').textContent).toBe('Copied ✓');
    expect(($('#keyBtn') as HTMLButtonElement).disabled).toBe(true);
    expect(has('#keyBtn', 'is-pending')).toBe(true);
    act(() => void vi.advanceTimersByTime(1200));
    expect($('#keyBtn').textContent).toBe('FEAT-7');
    expect(has('#keyBtn', 'is-pending')).toBe(true);
  });

  it('opens the board link through the host with its url, and never navigates', () => {
    const h = mountHeader(headerState({ ticketUrl: 'https://x/t' }));
    const proceeded = fireEvent.click($('#boardLink'));
    expect(proceeded).toBe(false);
    expect(h.send.openTicketLink).toHaveBeenCalledWith('https://x/t', 'req-1');
  });

  it('opens the ticket-data drawer in the overlay stack and posts nothing', () => {
    const h = mountHeader(headerState({ brief: 'The brief' }));
    const seen: Array<string | undefined> = [];
    h.overlays().subscribe(() => seen.push(h.overlays().getSnapshot().drawer?.text));
    fireEvent.click($('#ticketDataBtn'));
    expect(seen).toEqual(['The brief']);
    expect(Object.values(h.send).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});

describe('Header — Detach, Close and Reopen', () => {
  it('lists them as menu items inside the ticket-controls menu, not inline in the header', () => {
    mountHeader(headerState({ canDetachSubtask: true, canClose: true, canReopen: true }));
    for (const id of ['#detachSubtask', '#closeTicket', '#reopenTicket']) {
      expect($(id).closest('#menuPopover')).toBeTruthy();
      expect($(id).getAttribute('role')).toBe('menuitem');
      expect($(id).classList.contains('menuButton')).toBe(true);
    }
    expect(document.querySelector('.dhead > #closeTicket')).toBeNull();
  });

  it('keeps Close danger-styled with the "nothing is verified" title', () => {
    mountHeader(headerState({ canClose: true }));
    expect($('#closeTicket').getAttribute('title')).toBe('Mark closed: the work was done outside Karst. Nothing is verified');
    expect($('#closeTicket').classList.contains('danger')).toBe(true);
  });

  it('places the ⋯ menu directly after the agent picker and draws no Confirm ship button', () => {
    mountHeader(headerState());
    const kids = Array.from(document.querySelector('.headerActions')!.children);
    const agent = kids.findIndex((k) => k.querySelector('#agentButton'));
    expect(agent).toBeGreaterThanOrEqual(0);
    expect(kids[agent + 1]!.querySelector('#moreBtn')).toBeTruthy();
    expect(document.getElementById('confirmShip')).toBeNull();
  });

  it('follows the host flags without ever rewriting className', () => {
    const h = mountHeader(headerState());
    for (const id of ['#detachSubtask', '#closeTicket', '#reopenTicket']) expect(has(id, 'hidden')).toBe(true);
    h.emit({ type: 'state', state: headerState({ canDetachSubtask: true, canClose: true }) });
    expect(has('#detachSubtask', 'hidden')).toBe(false);
    expect(has('#closeTicket', 'hidden')).toBe(false);
    expect(has('#reopenTicket', 'hidden')).toBe(true);
    h.emit({ type: 'state', state: headerState({ canReopen: true }) });
    expect(has('#reopenTicket', 'hidden')).toBe(false);
    expect(has('#closeTicket', 'hidden')).toBe(true);
  });

  it('posts each payload-free message once, and keeps the pending class across a push', () => {
    const h = mountHeader(headerState({ canDetachSubtask: true, canClose: true, canReopen: true }));
    for (const [id, name] of [['#detachSubtask', 'detachSubtask'], ['#closeTicket', 'closeTicket'], ['#reopenTicket', 'reopenTicket']] as const) {
      fireEvent.click($(id));
      fireEvent.click($(id));
      expect(h.send[name]).toHaveBeenCalledTimes(1);
      expect(h.send[name]!.mock.calls[0]).toHaveLength(1);
    }
    h.emit({ type: 'state', state: headerState({ canDetachSubtask: true, canClose: true, canReopen: true, title: 'Renamed' }) });
    expect(has('#closeTicket', 'is-pending')).toBe(true);
  });
});

describe('Header — popovers', () => {
  const open = (id: string): boolean => !has(id, 'hidden') && has(id, 'open');

  it('opens one popover at a time and toggles on a second click of the trigger', () => {
    mountHeader(headerState());
    fireEvent.click($('#agentButton'));
    expect(open('#agentPopover')).toBe(true);
    expect($('#agentButton').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click($('#moreBtn'));
    expect(open('#agentPopover')).toBe(false);
    expect(open('#menuPopover')).toBe(true);
    expect($('#agentButton').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click($('#moreBtn'));
    expect(has('#menuPopover', 'hidden')).toBe(true);
    expect(has('#menuPopover', 'open')).toBe(false);
  });

  it('closes on a click elsewhere in the header, but not inside the popover', () => {
    mountHeader(headerState());
    fireEvent.click($('#agentButton'));
    fireEvent.click($('#agentPopover .fieldHelp'));
    expect(open('#agentPopover')).toBe(true);
    fireEvent.click($('#title'));
    expect(open('#agentPopover')).toBe(false);
  });

  it('stays open when the click detached its own target (a picker option replaced before bubbling)', () => {
    mountHeader(headerState());
    fireEvent.click($('#agentButton'));
    const option = document.createElement('div');
    $('#agentPopover .fieldHelp').append(option);
    option.addEventListener('click', () => option.remove());
    fireEvent.click(option);
    expect(open('#agentPopover')).toBe(true);
  });

  it('closes on a click anywhere outside the header (another region, an overlay, the page), and ignores Escape', () => {
    mountHeader(headerState());
    const outside = document.createElement('div');
    document.body.append(outside);
    fireEvent.click($('#moreBtn'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(open('#menuPopover')).toBe(true);
    fireEvent.click(outside);
    expect(open('#menuPopover')).toBe(false);
    fireEvent.click($('#agentButton'));
    expect(open('#agentPopover')).toBe(true);
    fireEvent.click(document.body);
    expect(open('#agentPopover')).toBe(false);
  });

  it('disables the agent button while a fix recovery owns the session', () => {
    mountHeader(headerState({ agentSession: { ...headerState().agentSession, canSwitch: false } }));
    expect(($('#agentButton') as HTMLButtonElement).disabled).toBe(true);
    expect($('#agentButton').getAttribute('title')).toBe('Cannot switch while a fix recovery is running');
  });

  it('paints the agent badge, model and live state', () => {
    mountHeader(headerState({ agentState: 'not-started' }));
    expect($('#agentCore .agentname').textContent).toBe('Claude Code');
    expect($('#agentModel').textContent).toBe('Model One');
    expect($('#agentLiveText').textContent).toBe('not-started');
    expect(has('#agentDot', 'not-started')).toBe(true);
  });
});
