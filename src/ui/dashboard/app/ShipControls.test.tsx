// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { $, has, headerState, installHeaderDoubles, mountHeader } from './fixtures/headerKit.js';

installHeaderDoubles();

const btn = (): HTMLButtonElement => $<HTMLButtonElement>('#confirmShip');

describe('ShipControls — the ship slot', () => {
  it('hides everything when no ship is offered', () => {
    mountHeader(headerState());
    expect(btn().hidden).toBe(true);
    expect(has('#shipWait', 'hidden')).toBe(true);
  });

  it.each([
    ['confirm', 'Confirm ship'],
    ['retry', 'Retry ship'],
  ])('offers %s as an enabled primary action', (kind, label) => {
    mountHeader(headerState({ ship: { kind, reason: null } }));
    expect(btn().hidden).toBe(false);
    expect(btn().textContent).toBe(label);
    expect(btn().getAttribute('aria-busy')).toBe('false');
    expect(btn().disabled).toBe(false);
  });

  it('shows Shipping... disabled and busy while the ship stage runs', () => {
    mountHeader(headerState({ ship: { kind: 'shipping' } }));
    expect(btn().textContent).toBe('Shipping…');
    expect(btn().disabled).toBe(true);
    expect(btn().getAttribute('aria-busy')).toBe('true');
  });

  it('holds Shipping... while a request is in flight (the rail started it), whatever the slot says, and lets go when it settles', () => {
    const h = mountHeader(headerState({ ship: { kind: 'confirm' } }));
    act(() => h.ops().beginShip('rail-1'));
    expect(btn().textContent).toBe('Shipping…');
    h.emit({ type: 'state', state: headerState({ ship: { kind: 'confirm' }, stageCurrent: 'ship', currentStage: { stageKey: 'ship', status: 'failed' } }) });
    expect(btn().textContent).toBe('Confirm ship');
  });

  it('replaces the button with the wait chip and names the repo count', () => {
    const h = mountHeader(headerState({ ship: { kind: 'waiting-merge', repos: 2 } }));
    expect(btn().hidden).toBe(true);
    expect(has('#shipWait', 'hidden')).toBe(false);
    expect($('#shipWait').getAttribute('title')).toBe('Waiting for 2 repos to be merged');
    h.emit({ type: 'state', state: headerState({ ship: { kind: 'waiting-merge', repos: 1 } }) });
    expect($('#shipWait').getAttribute('title')).toBe('Waiting for 1 repo to be merged');
    h.emit({ type: 'state', state: headerState({ ship: { kind: 'waiting-merge', repos: 0 } }) });
    expect($('#shipWait').getAttribute('title')).toBe('Waiting for the pull requests to be merged');
  });
});

describe('ShipControls — Confirm ship', () => {
  it('posts exactly once with no request id on the wire, and goes in flight in the state it shares with the rail', () => {
    const h = mountHeader(headerState({ ship: { kind: 'confirm' } }));
    const heard = vi.fn();
    window.addEventListener('karst:shipBegin', heard);
    fireEvent.click(btn());
    fireEvent.click(btn());
    window.removeEventListener('karst:shipBegin', heard);
    expect(h.send.shipTicket).toHaveBeenCalledTimes(1);
    expect(h.send.shipTicket).toHaveBeenCalledWith();
    expect(h.ops().getSnapshot().shipping).toBe(true);
    expect(heard).not.toHaveBeenCalled();
    expect(has('#confirmShip', 'is-pending')).toBe(true);
  });

  it('does nothing while a request is already in flight', () => {
    const h = mountHeader(headerState({ ship: { kind: 'confirm' } }));
    act(() => h.ops().beginShip('rail-1'));
    fireEvent.click(btn());
    expect(h.send.shipTicket).not.toHaveBeenCalled();
  });

  it('flashes "Shipped" in the toast once the ticket has left ship', () => {
    vi.useFakeTimers();
    const h = mountHeader(headerState({ ship: { kind: 'confirm' }, stageCurrent: 'ship' }));
    expect(has('#toast', 'show')).toBe(false);
    fireEvent.click(btn());
    h.emit({ type: 'state', state: headerState({ ship: { kind: 'none' }, stageCurrent: 'done' }) });
    expect(has('#toast', 'show')).toBe(true);
    expect($('#toast').textContent).toBe('Shipped ✓');
    act(() => void vi.advanceTimersByTime(1400));
    expect(has('#toast', 'show')).toBe(false);
  });
});

describe('ShipControls — wait chips', () => {
  it('words the sub-task wait from the host reason, and falls back to the default', () => {
    const h = mountHeader(headerState());
    expect(has('#subtaskWait', 'hidden')).toBe(true);
    const wait = (reason: string) => headerState({ currentStage: { stageKey: 'impl', status: 'running', blocked: { kind: 'awaiting-subtask', reason, at: 'x', resumable: false } } });
    h.emit({ type: 'state', state: wait('waiting on T2, T3') });
    expect(has('#subtaskWait', 'hidden')).toBe(false);
    expect($('#subtaskWaitText').textContent).toBe('Waiting on T2, T3');
    expect($('#subtaskWait').getAttribute('title')).toBe('This parent resumes when its sub-tasks are done.');
    h.emit({ type: 'state', state: wait('') });
    expect($('#subtaskWaitText').textContent).toBe('Waiting on sub-tasks');
  });

  it('shows the paused chip with a Resume that posts once', () => {
    const h = mountHeader(headerState({ paused: true }));
    expect(has('#pauseWait', 'hidden')).toBe(false);
    const resume = $('#pauseWait [data-act="unpause-execution"]');
    fireEvent.click(resume);
    fireEvent.click(resume);
    expect(h.send.unpauseExecution).toHaveBeenCalledTimes(1);
  });
});
