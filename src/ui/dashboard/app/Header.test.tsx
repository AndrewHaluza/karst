// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { $, has, headerState, installHeaderDoubles, mountHeader } from './fixtures/headerKit.js';
import { CLOSE_POPOVERS_EVENT, OPEN_TICKET_DATA_EVENT } from './headerSeam.js';

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

  it('asks the page to open the ticket-data drawer and posts nothing', () => {
    const h = mountHeader(headerState());
    const opened = vi.fn();
    window.addEventListener(OPEN_TICKET_DATA_EVENT, opened);
    fireEvent.click($('#ticketDataBtn'));
    window.removeEventListener(OPEN_TICKET_DATA_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(Object.values(h.send).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});

describe('Header — Detach, Close and Reopen', () => {
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

  it('closes when a vanilla control announces an outside click, and ignores Escape', () => {
    mountHeader(headerState());
    fireEvent.click($('#moreBtn'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(open('#menuPopover')).toBe(true);
    act(() => void window.dispatchEvent(new CustomEvent(CLOSE_POPOVERS_EVENT)));
    expect(open('#menuPopover')).toBe(false);
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
