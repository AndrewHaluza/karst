import { describe, expect, it } from 'vitest';
import type { InventoryServer, ServerInventory, SharedServer, TicketServerGroup } from '../../store/serverInventory.js';
import { buildServersState, unavailableServersState } from './serversState.js';

function server(id: number, repo: string, status = 'running', over: Partial<InventoryServer> = {}): InventoryServer {
  return {
    id, repo, host: 'localhost', port: 3000 + id, status, startedAt: null,
    logPath: null, container: null, cwd: null, sandbox: null, ...over,
  };
}
function shared(id: number, repo: string, over: Partial<SharedServer> = {}): SharedServer {
  return { ...server(id, repo), pinned: false, baseBranch: 'develop', dependents: [], ...over };
}
function group(ticketId: number, servers: InventoryServer[], over: Partial<TicketServerGroup> = {}): TicketServerGroup {
  return {
    ticketId, key: `T-${ticketId}`, title: `title ${ticketId}`, stage: 'impl', archived: false,
    done: false, dependencyDown: false, downServices: [], servers, ...over,
  };
}
const build = (inv: ServerInventory) => buildServersState(inv, 'Project p · this window');

describe('buildServersState', () => {
  it('flags the four empty states', () => {
    expect(build({ shared: [], tickets: [] }).empty).toBe('none');
    expect(build({ shared: [shared(1, 'api')], tickets: [] }).empty).toBe('shared-only');
    expect(build({ shared: [], tickets: [group(1, [server(2, 'web')])] }).empty).toBe('tickets-only');
    expect(build({ shared: [shared(1, 'api')], tickets: [group(1, [server(2, 'web')])] }).empty).toBeNull();
  });

  it('formats status word and address; an address only while running', () => {
    const s = build({ shared: [], tickets: [group(1, [server(2, 'web'), server(3, 'api', 'stopped'), server(4, 'db', 'failed')])] });
    expect(s.groups[0]!.servers.map((r) => [r.statusLabel, r.address, r.reachable])).toEqual([
      ['Running', 'localhost:3002', true],
      ['Stopped', '', false],
      ['Failed', '', false],
    ]);
  });

  it('keeps a running row with no port unreachable', () => {
    const s = build({ shared: [], tickets: [group(1, [server(2, 'web', 'running', { port: null })])] });
    expect(s.groups[0]!.servers[0]).toMatchObject({ address: '', reachable: false });
  });

  it('marks a pinned running shared row as kept running and never idle', () => {
    const s = build({ shared: [shared(1, 'api', { pinned: true })], tickets: [] });
    expect(s.shared[0]).toMatchObject({ pinned: true, keptRunning: true, idle: false });
    expect(s.stopIdle).toEqual({ count: 0, names: [], disabledReason: expect.stringContaining('kept running') });
  });

  it('a pinned but stopped shared row is not "kept running"', () => {
    const s = build({ shared: [shared(1, 'api', { pinned: true, status: 'stopped' })], tickets: [] });
    expect(s.shared[0]).toMatchObject({ pinned: true, keptRunning: false, idle: false });
  });

  it('names dependents, falling back to the formatted id, and marks done ones', () => {
    const s = build({
      shared: [shared(1, 'api', { dependents: [
        { ticketId: 5, key: 'T-5', title: null, done: false },
        { ticketId: 6, key: null, title: null, done: true },
      ] })],
      tickets: [],
    });
    expect(s.shared[0]!.dependents).toEqual([
      { label: 'T-5', done: false },
      { label: expect.stringContaining('6'), done: true },
    ]);
    expect(s.shared[0]!.idle).toBe(false);
  });

  it('offers Stop idle for running, dependent-free, unpinned rows and names them', () => {
    const s = build({ shared: [shared(1, 'api'), shared(2, 'db', { status: 'stopped' })], tickets: [] });
    expect(s.stopIdle).toEqual({ count: 1, names: ['api'], disabledReason: null });
    expect(s.summary).toMatchObject({ runningShared: 1, idleShared: 1 });
  });

  it('disables Stop idle with a distinct reason when nothing is running', () => {
    const s = build({ shared: [shared(1, 'api', { status: 'stopped' })], tickets: [] });
    expect(s.stopIdle.disabledReason).toBe('No shared service is running.');
  });

  it('counts running ticket rows and finished tickets with running rows', () => {
    const s = build({
      shared: [],
      tickets: [
        group(1, [server(2, 'web'), server(3, 'api', 'stopped')]),
        group(4, [server(5, 'web')], { done: true, stage: 'done' }),
        group(6, [server(7, 'web', 'stopped')], { done: true, stage: 'done' }),
        group(8, [server(9, 'web')], { archived: true, done: true }),
      ],
    });
    expect(s.summary).toMatchObject({ runningTickets: 3, finishedWithRunning: 1 });
    expect(s.groups.map((g) => [g.running, g.total, g.doneStillRunning, g.cleanUp])).toEqual([
      [1, 2, false, false],
      [1, 1, true, false],
      [0, 1, false, false],
      [1, 1, false, true],
    ]);
  });

  it('carries the down dependencies and never invents key/title', () => {
    const s = build({ shared: [], tickets: [group(3, [server(2, 'web')], { key: null, title: null, stage: null, downServices: ['api'] })] });
    expect(s.groups[0]).toMatchObject({ title: '', stage: '', downServices: ['api'] });
    expect(s.groups[0]!.key).toContain('3');
  });

  it('is explicit when unavailable', () => {
    const s = unavailableServersState('No project is open.');
    expect(s).toMatchObject({ available: false, empty: null, stopIdle: { disabledReason: 'No project is open.' } });
  });
});
