import { describe, expect, it, vi } from 'vitest';
import { pageHostBridge, type DashboardHostBridge, type PageGlobals } from './hostBridge.js';
import type { HostMessage } from '../messages.js';

describe('pageHostBridge', () => {
  it('throws an error if vscode global is missing', () => {
    expect(() => pageHostBridge({})).toThrow(/window\.vscode is missing/);
  });

  it('provides send, getState, setState, and subscribe over page globals', () => {
    const postMessage = vi.fn();
    const getState = vi.fn().mockReturnValue({ state: { ticket: { id: 123 } } });
    const setState = vi.fn();
    const mockVsCode = { postMessage, getState, setState };

    const bridge: DashboardHostBridge = pageHostBridge({
      vscode: mockVsCode,
    });

    expect(bridge.getState()).toEqual({ state: { ticket: { id: 123 } } });
    bridge.setState({ foo: 'bar' });
    expect(setState).toHaveBeenCalledWith({ foo: 'bar' });

    bridge.send.spinServers();
    expect(postMessage).toHaveBeenCalledWith({ type: 'spin-servers' });
  });

  it('subscribes via __karstSubscribe when available', () => {
    const unsubscribe = vi.fn();
    const subscribeMock = vi.fn().mockReturnValue(unsubscribe);

    const bridge = pageHostBridge({
      vscode: { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() },
      __karstSubscribe: subscribeMock,
    });

    const listener = vi.fn();
    const unsub = bridge.subscribe(listener);

    expect(subscribeMock).toHaveBeenCalledWith(listener);
    unsub();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('falls back to addEventListener("message") when __karstSubscribe is not available', () => {
    const listeners: Record<string, EventListenerOrEventListenerObject> = {};
    const scope: PageGlobals & EventTarget = {
      vscode: { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() },
      addEventListener: vi.fn((event: string, handler: EventListenerOrEventListenerObject) => {
        listeners[event] = handler;
      }),
      removeEventListener: vi.fn((event: string) => {
        delete listeners[event];
      }),
      dispatchEvent: vi.fn().mockReturnValue(true),
    };

    const bridge = pageHostBridge(scope);
    const received: HostMessage[] = [];
    const unsub = bridge.subscribe((msg) => received.push(msg));

    expect(scope.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));

    const testMsg: HostMessage = { type: 'bind', enabled: true };
    const handler = listeners['message'];
    if (typeof handler === 'function') {
      handler({ data: testMsg } as unknown as Event);
    }

    expect(received).toEqual([testMsg]);
    unsub();
    expect(scope.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });
});
