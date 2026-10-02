import { describe, expect, it, vi } from 'vitest';
import { pageHostBridge } from './hostBridge.js';
import type { PageGlobals, PageVsCodeApi } from './hostBridge.js';
import type { SettingsHostMessage } from '../messages.js';

describe('pageHostBridge', () => {
  it('throws when vscode is missing', () => {
    expect(() => pageHostBridge({} as PageGlobals)).toThrow(/window\.vscode is missing/);
  });

  it('posts request-state on subscribe', () => {
    const posted: unknown[] = [];
    const mockApi: PageVsCodeApi = {
      postMessage: (m: unknown) => posted.push(m),
      getState: () => undefined,
      setState: () => {},
    };
    const bridge = pageHostBridge({ vscode: mockApi });
    const listener = vi.fn();
    bridge.subscribe(listener);
    expect(posted).toContainEqual({ type: 'request-state' });
  });

  it('uses __karstSubscribe and flushes buffered messages when present', () => {
    const posted: unknown[] = [];
    const mockApi: PageVsCodeApi = {
      postMessage: (m: unknown) => posted.push(m),
      getState: () => undefined,
      setState: () => {},
    };
    const received: SettingsHostMessage[] = [];
    const mockMessage: SettingsHostMessage = { type: 'saved', section: 'general' };
    const mockSubscribe = vi.fn((listener: (m: SettingsHostMessage) => void) => {
      listener(mockMessage);
      return () => {};
    });

    const bridge = pageHostBridge({
      vscode: mockApi,
      __karstSubscribe: mockSubscribe,
    });

    bridge.subscribe((m) => received.push(m));
    expect(mockSubscribe).toHaveBeenCalled();
    expect(received).toEqual([mockMessage]);
    expect(posted).toContainEqual({ type: 'request-state' });
  });
});
