import { describe, expect, it, vi } from 'vitest';
import {
  parseServerLogsMessage,
  routeServerLogsAction,
  type ServerLogsActions,
} from './messages.js';

describe('parseServerLogsMessage', () => {
  it('accepts the two permitted webview messages', () => {
    expect(parseServerLogsMessage({ type: 'server-logs-request' })).toEqual({
      type: 'server-logs-request',
    });
    expect(parseServerLogsMessage({ type: 'server-logs-close' })).toEqual({
      type: 'server-logs-close',
    });
  });

  it('returns null for anything unrecognised or non-object', () => {
    expect(parseServerLogsMessage(null)).toBeNull();
    expect(parseServerLogsMessage('server-logs-request')).toBeNull();
    expect(parseServerLogsMessage(42)).toBeNull();
    // A host→webview message and a dashboard-only message are not this panel's.
    expect(parseServerLogsMessage({ type: 'server-logs' })).toBeNull();
    expect(parseServerLogsMessage({ type: 'server-logs-tab', tab: 'web' })).toBeNull();
    expect(parseServerLogsMessage({ type: 'server-logs-detach' })).toBeNull();
    expect(parseServerLogsMessage({})).toBeNull();
  });

  it('drops companion fields rather than reshaping the message', () => {
    expect(parseServerLogsMessage({ type: 'server-logs-request', ticketId: 9 })).toEqual({
      type: 'server-logs-request',
    });
    expect(parseServerLogsMessage({ type: 'server-logs-close', path: '/forged' })).toEqual({
      type: 'server-logs-close',
    });
  });
});

describe('routeServerLogsAction', () => {
  it('dispatches each already-parsed message to its action', () => {
    const actions: ServerLogsActions = { request: vi.fn(), close: vi.fn() };
    routeServerLogsAction({ type: 'server-logs-request' }, actions);
    routeServerLogsAction({ type: 'server-logs-close' }, actions);
    expect(actions.request).toHaveBeenCalledOnce();
    expect(actions.close).toHaveBeenCalledOnce();
  });

  it('returns whatever the action returns, so the dispatch seam can await it', async () => {
    const pending = Promise.resolve();
    const actions: ServerLogsActions = { request: vi.fn(() => pending), close: vi.fn() };
    expect(routeServerLogsAction({ type: 'server-logs-request' }, actions)).toBe(pending);
    await pending;
  });
});
