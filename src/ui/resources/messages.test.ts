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

describe('parseResourcesMessage — servers verbs', () => {
  it.each(['server-start', 'server-restart', 'server-stop', 'server-open', 'server-copy'] as const)(
    '%s carries one positive servers.id and nothing else',
    (type) => {
      expect(parseResourcesMessage({ type, serverId: 4, pid: 1, path: '/x' })).toEqual({ type, serverId: 4 });
      expect(parseResourcesMessage({ type })).toBeNull();
      expect(parseResourcesMessage({ type, serverId: 0 })).toBeNull();
      expect(parseResourcesMessage({ type, serverId: '4' })).toBeNull();
    },
  );

  it.each(['shared-start', 'shared-restart', 'shared-stop'] as const)('%s carries one unit key', (type) => {
    expect(parseResourcesMessage({ type, repo: 'api/web', cwd: '/x' })).toEqual({ type, repo: 'api/web' });
    expect(parseResourcesMessage({ type })).toBeNull();
    expect(parseResourcesMessage({ type, repo: '' })).toBeNull();
    expect(parseResourcesMessage({ type, repo: 7 })).toBeNull();
    expect(parseResourcesMessage({ type, repo: 'x'.repeat(201) })).toBeNull();
  });

  it('shared-pin needs a key and a real boolean', () => {
    expect(parseResourcesMessage({ type: 'shared-pin', repo: 'api', pinned: true })).toEqual({
      type: 'shared-pin', repo: 'api', pinned: true,
    });
    expect(parseResourcesMessage({ type: 'shared-pin', repo: 'api', pinned: false })).toEqual({
      type: 'shared-pin', repo: 'api', pinned: false,
    });
    expect(parseResourcesMessage({ type: 'shared-pin', repo: 'api' })).toBeNull();
    expect(parseResourcesMessage({ type: 'shared-pin', repo: 'api', pinned: 'yes' })).toBeNull();
    expect(parseResourcesMessage({ type: 'shared-pin', pinned: true })).toBeNull();
  });

  it.each(['ticket-stop-all', 'ticket-logs'] as const)('%s carries one positive ticketId', (type) => {
    expect(parseResourcesMessage({ type, ticketId: 9, serverId: 1 })).toEqual({ type, ticketId: 9 });
    expect(parseResourcesMessage({ type })).toBeNull();
    expect(parseResourcesMessage({ type, ticketId: -2 })).toBeNull();
  });

  it('stop-idle and open-logs are bare', () => {
    expect(parseResourcesMessage({ type: 'stop-idle', repo: 'api' })).toEqual({ type: 'stop-idle' });
    expect(parseResourcesMessage({ type: 'open-logs', path: '/x' })).toEqual({ type: 'open-logs' });
  });
});

describe('routeResourcesAction', () => {
  const make = (): ResourcesActions => ({
    requestState: vi.fn(), killServer: vi.fn(), refresh: vi.fn(), measureDisk: vi.fn(),
    sharedStart: vi.fn(), sharedRestart: vi.fn(), sharedStop: vi.fn(), sharedPin: vi.fn(),
    stopIdle: vi.fn(), serverStart: vi.fn(), serverRestart: vi.fn(), serverStop: vi.fn(),
    serverOpen: vi.fn(), serverCopy: vi.fn(), ticketStopAll: vi.fn(), ticketLogs: vi.fn(),
    openLogs: vi.fn(),
  });

  it('dispatches each parsed message to its action with its arguments', () => {
    const actions = make();
    routeResourcesAction({ type: 'request-state' }, actions);
    routeResourcesAction({ type: 'refresh' }, actions);
    routeResourcesAction({ type: 'measure-disk' }, actions);
    routeResourcesAction({ type: 'kill-server', serverId: 3 }, actions);
    routeResourcesAction({ type: 'shared-start', repo: 'api' }, actions);
    routeResourcesAction({ type: 'shared-restart', repo: 'api' }, actions);
    routeResourcesAction({ type: 'shared-stop', repo: 'web' }, actions);
    routeResourcesAction({ type: 'shared-pin', repo: 'web', pinned: true }, actions);
    routeResourcesAction({ type: 'stop-idle' }, actions);
    routeResourcesAction({ type: 'server-start', serverId: 5 }, actions);
    routeResourcesAction({ type: 'server-restart', serverId: 6 }, actions);
    routeResourcesAction({ type: 'server-stop', serverId: 7 }, actions);
    routeResourcesAction({ type: 'server-open', serverId: 8 }, actions);
    routeResourcesAction({ type: 'server-copy', serverId: 9 }, actions);
    routeResourcesAction({ type: 'ticket-stop-all', ticketId: 2 }, actions);
    routeResourcesAction({ type: 'ticket-logs', ticketId: 4 }, actions);
    routeResourcesAction({ type: 'open-logs' }, actions);
    expect(actions.requestState).toHaveBeenCalledTimes(1);
    expect(actions.refresh).toHaveBeenCalledTimes(1);
    expect(actions.measureDisk).toHaveBeenCalledTimes(1);
    expect(actions.killServer).toHaveBeenCalledWith(3);
    expect(actions.sharedStart).toHaveBeenCalledWith('api');
    expect(actions.sharedRestart).toHaveBeenCalledWith('api');
    expect(actions.sharedStop).toHaveBeenCalledWith('web');
    expect(actions.sharedPin).toHaveBeenCalledWith('web', true);
    expect(actions.stopIdle).toHaveBeenCalledTimes(1);
    expect(actions.serverStart).toHaveBeenCalledWith(5);
    expect(actions.serverRestart).toHaveBeenCalledWith(6);
    expect(actions.serverStop).toHaveBeenCalledWith(7);
    expect(actions.serverOpen).toHaveBeenCalledWith(8);
    expect(actions.serverCopy).toHaveBeenCalledWith(9);
    expect(actions.ticketStopAll).toHaveBeenCalledWith(2);
    expect(actions.ticketLogs).toHaveBeenCalledWith(4);
    expect(actions.openLogs).toHaveBeenCalledTimes(1);
  });
});
