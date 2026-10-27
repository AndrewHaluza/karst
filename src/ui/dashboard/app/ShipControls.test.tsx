// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { $, has, headerState, installHeaderDoubles, mountHeader } from './fixtures/headerKit.js';

installHeaderDoubles();

describe('ShipControls — the ship slot', () => {
  it('hides the wait chip when no ship is parked', () => {
    mountHeader(headerState());
    expect(has('#shipWait', 'hidden')).toBe(true);
  });

  it.each(['confirm', 'retry', 'shipping'])('draws no header ship button for the %s slot (shipping lives on the rail)', (kind) => {
    mountHeader(headerState({ ship: { kind, reason: null } }));
    expect(document.getElementById('confirmShip')).toBeNull();
    expect(document.querySelector('.dhead [data-act="ship-ticket"]')).toBeNull();
  });

  it('shows the wait chip and names the repo count', () => {
    const h = mountHeader(headerState({ ship: { kind: 'waiting-merge', repos: 2 } }));
    expect(has('#shipWait', 'hidden')).toBe(false);
    expect($('#shipWait').getAttribute('title')).toBe('Waiting for 2 repos to be merged');
    h.emit({ type: 'state', state: headerState({ ship: { kind: 'waiting-merge', repos: 1 } }) });
    expect($('#shipWait').getAttribute('title')).toBe('Waiting for 1 repo to be merged');
    h.emit({ type: 'state', state: headerState({ ship: { kind: 'waiting-merge', repos: 0 } }) });
    expect($('#shipWait').getAttribute('title')).toBe('Waiting for the pull requests to be merged');
  });
});

describe('ShipControls — toast', () => {
  it('flashes "Shipped" once a rail-started ship leaves the ship stage', () => {
    vi.useFakeTimers();
    const h = mountHeader(headerState({ ship: { kind: 'confirm' }, stageCurrent: 'ship' }));
    expect(has('#toast', 'show')).toBe(false);
    act(() => h.ops().beginShip('rail-1'));
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
