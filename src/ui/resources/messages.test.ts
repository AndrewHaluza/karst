import { describe, expect, it, vi } from 'vitest';
import { parseResourcesMessage, routeResourcesAction, type ResourcesActions } from './messages.js';

describe('parseResourcesMessage', () => {
  it('parses request-state', () => {
    expect(parseResourcesMessage({ type: 'request-state' })).toEqual({ type: 'request-state' });
  });

  it('parses refresh', () => {
    expect(parseResourcesMessage({ type: 'refresh' })).toEqual({ type: 'refresh' });
  });

  it('parses measure-disk', () => {
    expect(parseResourcesMessage({ type: 'measure-disk' })).toEqual({ type: 'measure-disk' });
  });

  it('parses kill-server with a positive safe integer', () => {
    expect(parseResourcesMessage({ type: 'kill-server', serverId: 3 })).toEqual({
      type: 'kill-server',
      serverId: 3,
    });
  });

  it('rejects kill-server without a positive safe integer serverId', () => {
    expect(parseResourcesMessage({ type: 'kill-server' })).toBeNull();
    expect(parseResourcesMessage({ type: 'kill-server', serverId: 0 })).toBeNull();
    expect(parseResourcesMessage({ type: 'kill-server', serverId: -1 })).toBeNull();
    expect(parseResourcesMessage({ type: 'kill-server', serverId: 1.5 })).toBeNull();
    expect(parseResourcesMessage({ type: 'kill-server', serverId: '3' })).toBeNull();
  });

  it('never carries a pid or a path — only a servers.id is modelled', () => {
    // Extra fields are dropped by the narrowing, never passed through.
    expect(parseResourcesMessage({ type: 'kill-server', serverId: 3, pid: 999, path: '/tmp/x' })).toEqual({
      type: 'kill-server',
      serverId: 3,
    });
    // A message that names ONLY a pid (no serverId) is refused outright.
    expect(parseResourcesMessage({ type: 'kill-server', pid: 999 })).toBeNull();
    expect(parseResourcesMessage({ type: 'kill-server', path: '/tmp/x' })).toBeNull();
  });

  it('rejects unknown message types and malformed shapes', () => {
    expect(parseResourcesMessage({ type: 'nuke' })).toBeNull();
    expect(parseResourcesMessage(null)).toBeNull();
    expect(parseResourcesMessage('refresh')).toBeNull();
  });
});

describe('routeResourcesAction', () => {
  it('dispatches each parsed message to its action', () => {
    const actions: ResourcesActions = {
      requestState: vi.fn(),
      killServer: vi.fn(),
      refresh: vi.fn(),
      measureDisk: vi.fn(),
    };
    routeResourcesAction({ type: 'request-state' }, actions);
    routeResourcesAction({ type: 'refresh' }, actions);
    routeResourcesAction({ type: 'measure-disk' }, actions);
    routeResourcesAction({ type: 'kill-server', serverId: 3 }, actions);
    expect(actions.requestState).toHaveBeenCalledTimes(1);
    expect(actions.refresh).toHaveBeenCalledTimes(1);
    expect(actions.measureDisk).toHaveBeenCalledTimes(1);
    expect(actions.killServer).toHaveBeenCalledWith(3);
  });
});
