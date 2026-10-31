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

  describe('view-state persistence', () => {
    const bridgeWith = (getState: () => unknown) => {
      let subscriber: ((msg: HostMessage) => void) | null = null;
      const setState = vi.fn();
      const bridge: DashboardHostBridge = {
        send: {} as unknown as DashboardHostBridge['send'],
        getState,
        setState,
        subscribe: (fn) => {
          subscriber = fn;
          return () => {};
        },
      };
      return { bridge, setState, push: (msg: HostMessage) => act(() => subscriber?.(msg)) };
    };
    const snap = (id: number) => ({ ticketId: id }) as unknown as DashboardState;

    it('writes the envelope on a real push and not on a live repaint', () => {
      const { bridge, setState, push } = bridgeWith(() => null);
      render(
        <DashboardAppProvider bridge={bridge}>
          <TestConsumer />
        </DashboardAppProvider>,
      );
      push({ type: 'state', state: snap(1), live: true });
      expect(setState).not.toHaveBeenCalled();
      push({ type: 'state', state: snap(2) });
      expect(setState).toHaveBeenCalledTimes(1);
      expect(setState).toHaveBeenCalledWith({
        state: snap(2),
        sel: null,
        shipWait: null,
        srvFilter: '',
        artView: null,
        artScrolls: { ticket: 0, index: 0, detail: {} },
        history: [],
      });
    });

    it('shows a snapshot persisted bare by an older build, and upgrades it to the envelope on the next push', () => {
      const { bridge, setState, push } = bridgeWith(() => snap(41));
      render(
        <DashboardAppProvider bridge={bridge}>
          <TestConsumer />
        </DashboardAppProvider>,
      );
      expect(screen.getByTestId('ticket-id').textContent).toBe('T41');
      expect(setState).not.toHaveBeenCalled();
      push({ type: 'state', state: snap(41) });
      expect(setState).toHaveBeenCalledWith(expect.objectContaining({ state: snap(41), sel: null, srvFilter: '' }));
    });

    it('survives a getState that throws', () => {
      const { bridge } = bridgeWith(() => {
        throw new Error('no state');
      });
      render(
        <DashboardAppProvider bridge={bridge}>
          <TestConsumer />
        </DashboardAppProvider>,
      );
      expect(screen.getByTestId('ticket-id').textContent).toBe('no-ticket');
    });
  });

  it("settles the runtime's pending request from the host's action-result", () => {
    let subscriber: ((msg: HostMessage) => void) | null = null;
    const settle = vi.fn();
    (globalThis as unknown as { karstSettle: typeof settle }).karstSettle = settle;
    render(
      <DashboardAppProvider
        bridge={{
          send: {} as unknown as DashboardHostBridge['send'],
          getState: () => null,
          setState: vi.fn(),
          subscribe: (fn) => {
            subscriber = fn;
            return () => {};
          },
        }}
      >
        <TestConsumer />
      </DashboardAppProvider>,
    );
    act(() => subscriber?.({ type: 'action-result', requestId: 'r1', ok: false, message: 'Refused.' }));
    expect(settle).toHaveBeenCalledExactlyOnceWith('r1', false, 'Refused.');
  });
});
