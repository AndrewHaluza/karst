import { describe, expect, it } from 'vitest';
import { buildServersIndicator } from './serversStatus.js';
import type { InventoryServer, ServerInventory } from '../store/serverInventory.js';

const sv = (id: number, status: string): InventoryServer => ({
  id, repo: 'r', host: null, port: null, status, startedAt: null, logPath: null, container: null, cwd: null, sandbox: null,
});
const shared = (id: number, status: string) => ({ ...sv(id, status), pinned: false, baseBranch: null, dependents: [] });
const group = (servers: InventoryServer[]) => ({
  ticketId: 1, key: 'T', title: 't', stage: 'impl', archived: false, done: false,
  dependencyDown: false, downServices: [], servers,
});

describe('buildServersIndicator', () => {
  it('is hidden with no inventory or nothing running', () => {
    expect(buildServersIndicator(undefined)).toBeNull();
    const idle: ServerInventory = { shared: [shared(1, 'stopped')], tickets: [group([sv(2, 'stopped')])] };
    expect(buildServersIndicator(idle)).toBeNull();
  });

  it('counts running ticket and shared rows, singular and plural', () => {
    expect(buildServersIndicator({ shared: [shared(1, 'running')], tickets: [] })).toEqual({
      text: '$(server) Karst: 1 server',
      tooltip: '0 ticket servers, 1 shared — open Servers',
    });
    expect(
      buildServersIndicator({ shared: [shared(1, 'running')], tickets: [group([sv(2, 'running'), sv(3, 'stopped')])] }),
    ).toEqual({ text: '$(server) Karst: 2 servers', tooltip: '1 ticket server, 1 shared — open Servers' });
  });
});
