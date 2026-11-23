import { describe, expect, it } from 'vitest';
import { buildServersIndicator } from './serversStatus.js';
import type { InventoryServer, ServerInventory } from '../store/serverInventory.js';

const sv = (id: number, status: string): InventoryServer => ({
  id, repo: 'r', host: null, port: null, status, startedAt: null, logPath: null, container: null, cwd: null, sandbox: null,
  lastError: null, httpHealth: true,
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
      accessibilityLabel: 'Karst: 1 server running. 0 ticket servers, 1 shared. Open Servers.',
      warning: false,
    });
    expect(
      buildServersIndicator({ shared: [shared(1, 'running')], tickets: [group([sv(2, 'running'), sv(3, 'stopped')])] }),
    ).toMatchObject({ text: '$(server) Karst: 2 servers', tooltip: '1 ticket server, 1 shared — open Servers', warning: false });
  });

  const failed = (id: number, repo: string, reason: string | null): InventoryServer => ({ ...sv(id, 'failed'), repo, lastError: reason });

  it('shows a failed server with no running one, in the warning colour, and names it with its reason', () => {
    const indicator = buildServersIndicator({ shared: [], tickets: [group([failed(2, 'api', 'Port 3000 in use by pid 4123')])] });
    expect(indicator).toEqual({
      text: '$(error) Karst: 1 server failed',
      tooltip: 'api: Port 3000 in use by pid 4123 — open Servers',
      accessibilityLabel: 'Karst: 1 server failed. api: Port 3000 in use by pid 4123. Open Servers.',
      warning: true,
    });
  });

  it('puts the failed count first when servers also run, plural, with a reason-less row named alone', () => {
    const indicator = buildServersIndicator({
      shared: [{ ...shared(1, 'running') }],
      tickets: [group([failed(2, 'api', 'Exited with code 1'), failed(3, 'web', null), sv(4, 'running')])],
    });
    expect(indicator).toMatchObject({ text: '$(error) Karst: 2 servers failed', warning: true });
    expect(indicator!.tooltip).toBe('api: Exited with code 1\nweb\n2 servers running — open Servers');
  });
});
