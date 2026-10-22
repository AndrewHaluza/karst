// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import type { DashboardHostBridge } from './hostBridge.js';
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import {
  DashboardAppProvider,
  useDashboardBridge,
  useDashboardSend,
  useDashboardState,
} from './DashboardAppContext.js';

function TestConsumer() {
  const state = useDashboardState();
  const bridge = useDashboardBridge();
  const send = useDashboardSend();

  return (
    <div>
      <div data-testid="ticket-id">{state?.ticketId ? `T${state.ticketId}` : 'no-ticket'}</div>
      <button
        type="button"
        data-testid="spin-btn"
        onClick={() => send.spinServers()}
      >
        Spin
      </button>
      <div data-testid="has-bridge">{bridge ? 'yes' : 'no'}</div>
    </div>
  );
}

describe('DashboardAppContext', () => {
  afterEach(() => {
    cleanup();
  });
  it('subscribes to bridge messages and updates state on state push', () => {
    let subscriber: ((msg: HostMessage) => void) | null = null;
    const postMessage = vi.fn();
    const fakeBridge: DashboardHostBridge = {
      send: { spinServers: () => postMessage({ type: 'spin-servers' }) } as unknown as DashboardHostBridge['send'],
      getState: () => null,
      setState: vi.fn(),
      subscribe: (fn) => {
        subscriber = fn;
        return () => {
          subscriber = null;
        };
      },
    };

    render(
      <DashboardAppProvider bridge={fakeBridge}>
        <TestConsumer />
      </DashboardAppProvider>,
    );

    expect(screen.getByTestId('ticket-id').textContent).toBe('no-ticket');
    expect(screen.getByTestId('has-bridge').textContent).toBe('yes');

    // Simulate state push
    const mockState = { ticketId: 740 } as unknown as DashboardState;
    act(() => {
      subscriber?.({ type: 'state', state: mockState });
    });

    expect(screen.getByTestId('ticket-id').textContent).toBe('T740');

    // Test send hook
    screen.getByTestId('spin-btn').click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'spin-servers' });
  });

  it('restores initial state from bridge.getState() if present', () => {
    const mockState = { ticketId: 999 } as unknown as DashboardState;
    const fakeBridge: DashboardHostBridge = {
      send: {} as unknown as DashboardHostBridge['send'],
      getState: () => ({ state: mockState }),
      setState: vi.fn(),
      subscribe: () => () => {},
    };

    render(
      <DashboardAppProvider bridge={fakeBridge}>
        <TestConsumer />
      </DashboardAppProvider>,
    );

    expect(screen.getByTestId('ticket-id').textContent).toBe('T999');
  });
});
