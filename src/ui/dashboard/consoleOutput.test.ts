import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { DashboardConsole } from './consoleOutput.js';
import type { DashboardPanel } from './panelTypes.js';
import type { ServerLogsReader } from './serverLogsReader.js';

function fakeReader(): ServerLogsReader {
  return {
    readLogs: (servers: Array<{ service: string; logPath: string | null }>) => ({
      servers: servers.map((s) => ({ ...s, content: '', truncated: false })),
    }),
    startPolling: () => Promise.resolve(),
    stopPolling: () => {},
  } as unknown as ServerLogsReader;
}

describe('DashboardConsole server logs', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function addServer(ticketId: number | null, repo: string, logPath: string | null): void {
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path)
         VALUES (?, ?, 'localhost', 4000, 7, 'running', ?)`,
      )
      .run(ticketId, repo, logPath);
  }

  it('lists the ticket’s own services and its shared services in one logs view', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addServer(t.id, 'web', '/tmp/web.log');
    const posted: unknown[] = [];
    const panel = {
      postMessage: (m: unknown) => posted.push(m),
    } as unknown as DashboardPanel;

    const console = new DashboardConsole(
      store,
      () => panel,
      undefined,
      undefined,
      fakeReader(),
      () => [{ service: 'api', logPath: '/tmp/api.log' }],
    );
    console.requestServerLogs(t.id);

    expect(posted[0]).toMatchObject({
      type: 'server-logs',
      servers: [
        { service: 'web', logPath: '/tmp/web.log' },
        { service: 'api', logPath: '/tmp/api.log' },
      ],
    });
    console.closeServerLogs(t.id);
  });

  it('does not list a shared service twice when the ticket also runs that key', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addServer(t.id, 'web', '/tmp/web.log');
    const posted: unknown[] = [];
    const panel = {
      postMessage: (m: unknown) => posted.push(m),
    } as unknown as DashboardPanel;

    const console = new DashboardConsole(
      store,
      () => panel,
      undefined,
      undefined,
      fakeReader(),
      () => [{ service: 'web', logPath: '/tmp/shared-web.log' }],
    );
    console.requestServerLogs(t.id);
    console.closeServerLogs(t.id);

    expect((posted[0] as { servers: unknown[] }).servers).toHaveLength(1);
  });
});
