import type {
  ResourcesState,
  ResourceRowView,
  UnknownRowView,
  WasteRowView,
  DiskRowView,
  TrendTick,
  TrendYTick,
  MonitorFact,
} from './state.js';
import type { ResourceSample } from '../../runtime/resourceMonitor.js';
import type { InventoryServer, ServerInventory, SharedServer, TicketServerGroup } from '../../store/serverInventory.js';
import { buildServersState, unavailableServersState, type ServersState } from './serversState.js';
import type { PanelTab, ResourcesHostMessage } from './messages.js';

/**
 * The checked-in render fixture corpus for the resources webview.
 *
 * Every fixture is built ONLY from production presentation shapes and is
 * pure data: no SQLite reads, no real worktrees. Every server id is in the
 * reserved numeric band 900001–999999 (Key Decision 5); every path is
 * `fixture:`-prefixed. Deliberately long, hostile, untrusted labels and
 * paths ensure render tests exercise escaping.
 */

export type ResourcesScenario =
  | 'unsupported'
  | 'degraded'
  | 'idle'
  | 'busy'
  | 'waste'
  | 'unattributed'
  | 'hostile'
  | 'servers-mixed'
  | 'servers-shared-only'
  | 'servers-tickets-only'
  | 'servers-done'
  | 'servers-archived'
  | 'servers-idle'
  | 'servers-none'
  | 'servers-unavailable'
  | 'servers-hostile';

export const RESOURCES_SCENARIOS: readonly ResourcesScenario[] = [
  'unsupported', 'degraded', 'idle', 'busy', 'waste', 'unattributed', 'hostile',
  'servers-mixed', 'servers-shared-only', 'servers-tickets-only', 'servers-done',
  'servers-archived', 'servers-idle', 'servers-none', 'servers-unavailable', 'servers-hostile',
];

export interface ResourcesRenderFixture {
  scenario: ResourcesScenario;
  /** The Resources tab's read model (every fixture has one, as the host always pushes it). */
  state: ResourcesState;
  /** The Servers tab's read model; present for the `servers-*` scenarios. */
  servers?: ServersState;
  /** The tab the fixture opens on (the host's `show-tab`); absent → the default. */
  tab?: PanelTab;
}

/** The host messages a fixture stands for, in the order the host sends them. */
export function fixtureMessages(fixture: ResourcesRenderFixture): ResourcesHostMessage[] {
  return [
    { type: 'state', state: fixture.state },
    ...(fixture.servers ? [{ type: 'servers', state: fixture.servers } as const] : []),
    ...(fixture.tab ? [{ type: 'show-tab', tab: fixture.tab } as const] : []),
  ];
}

const HOSTILE_LABEL = '<script>alert(1)</script>';
const HOSTILE_PATH = 'fixture:<script>&src/main.ts';
const HOSTILE_LONG = 'Z'.repeat(300);

function fixtureRow(index: number, overrides?: Partial<ResourceRowView>): ResourceRowView {
  return {
    ticketKey: `FEAT-${100 + index}`,
    ticketTitle: `Ticket ${index + 1}`,
    label: `fixture:repo:${index}`,
    pid: 900001 + index,
    cpuPct: 5 + index,
    cpuPctDisplay: `${5 + index}%`,
    rssBytes: 10_000_000 * (index + 1),
    rssDisplay: `${(index + 1) * 10} MB`,
    procCount: 1 + index,
    uptimeMs: 60_000 * (index + 1),
    uptimeDisplay: `${index + 1}m 0s`,
    attribution: 'attributable',
    ...overrides,
  };
}

function fixtureUnknown(index: number): UnknownRowView {
  return { pid: 900010 + index, comm: `unknown-${index}`, rssDisplay: `${index} MB`, cpuPctDisplay: `${index}%`, procCount: 1 };
}

function fixtureWaste(index: number, overrides?: Partial<WasteRowView>): WasteRowView {
  return { kind: 'orphan', reason: `fixture:waste:${index}`, rssBytes: 5_000_000, rssDisplay: '5 MB', killable: true, serverId: 900020 + index, ...overrides };
}

function fixtureDisk(index: number): DiskRowView {
  return { path: `fixture:/repo/${index}/node_modules`, display: `repo/${index}/node_modules`, bytes: 100_000_000 * (index + 1), sizeDisplay: `${(index + 1) * 100} MB`, measuredMs: 1735689600000 };
}

function fixtureSample(index: number, cpuPct: number | null = 10 + index): ResourceSample {
  return { takenMs: 1735689600000 + index * 2000, totals: { rssBytes: 50_000_000 + index * 1_000_000, cpuPct } };
}

function fixtureTick(index: number, total: number): TrendTick {
  return { label: `${index * 5}s`, fraction: index / (total - 1 || 1) };
}

function fixtureYTick(fraction: number): TrendYTick {
  return { fraction, cpu: `${Math.round(fraction * 80)}%`, rss: `${Math.round(fraction * 100)} MB` };
}

function unsupportedState(): ResourcesState {
  return {
    supported: false, degraded: false,
    totals: { rssBytes: 0, cpuPct: null }, rssDisplay: '—', cpuPctDisplay: '—',
    rows: [], unknown: [], waste: [], history: [], disk: [],
    sampleAgeDisplay: '—', scopeLabel: '', wasteCount: 0, attributedRoots: 0, unattributedShown: 0,
    trend: { cpuMaxDisplay: '—', rssMaxDisplay: '—', timeTicks: [], yTicks: [] },
    historyMax: 150, cpuTrend: 'steady', recentCpu: [], facts: [],
  };
}

function degradedState(): ResourcesState {
  return {
    ...unsupportedState(), supported: true, degraded: true,
    sampleAgeDisplay: 'sampling…',
    facts: [{ label: 'Status', value: 'degraded' }],
  };
}

function idleState(): ResourcesState {
  return {
    supported: true, degraded: false,
    totals: { rssBytes: 0, cpuPct: null }, rssDisplay: '—', cpuPctDisplay: '—',
    rows: [], unknown: [], waste: [], history: [], disk: [],
    sampleAgeDisplay: 'sampling…', scopeLabel: 'Project test · this window',
    wasteCount: 0, attributedRoots: 0, unattributedShown: 0,
    trend: { cpuMaxDisplay: '—', rssMaxDisplay: '—', timeTicks: [], yTicks: [] },
    historyMax: 150, cpuTrend: 'steady', recentCpu: [], facts: [],
  };
}

function busyState(): ResourcesState {
  const history = Array.from({ length: 150 }, (_, i) => fixtureSample(i));
  return {
    supported: true, degraded: false,
    totals: { rssBytes: 80_000_000, cpuPct: 35 },
    rssDisplay: '80 MB', cpuPctDisplay: '35%',
    rows: [fixtureRow(0), fixtureRow(1)],
    unknown: [fixtureUnknown(0)],
    waste: [], history, disk: [fixtureDisk(0)],
    sampleAgeDisplay: 'sampled 2s ago', scopeLabel: 'Project test · this window',
    wasteCount: 0, attributedRoots: 2, unattributedShown: 1,
    trend: {
      cpuMaxDisplay: '80%', rssMaxDisplay: '100 MB',
      timeTicks: [fixtureTick(0, 5), fixtureTick(1, 5), fixtureTick(2, 5), fixtureTick(3, 5), fixtureTick(4, 5)],
      yTicks: [fixtureYTick(0), fixtureYTick(0.25), fixtureYTick(0.5), fixtureYTick(0.75), fixtureYTick(1)],
    },
    historyMax: 150, cpuTrend: 'rising', recentCpu: [10, 15, 20, 25, 30],
    facts: [{ label: 'Scope', value: '2 servers' }],
  };
}

function wasteState(): ResourcesState {
  return {
    ...busyState(),
    waste: [fixtureWaste(0), fixtureWaste(1)],
    wasteCount: 2,
  };
}

function unattributedState(): ResourcesState {
  return {
    ...busyState(),
    unknown: [fixtureUnknown(0), fixtureUnknown(1)],
    unattributedShown: 2,
  };
}

function hostileState(): ResourcesState {
  const busy = busyState();
  return {
    ...busy,
    rows: [fixtureRow(0, { label: HOSTILE_LABEL, ticketTitle: 'A & B "quoted" <b>' })],
    unknown: [fixtureUnknown(0)],
    waste: [fixtureWaste(0, { reason: HOSTILE_LABEL })],
    wasteCount: 1,
    disk: [fixtureDisk(0)],
    facts: [{ label: HOSTILE_LABEL, value: HOSTILE_LONG }],
  };
}

// ------------------------------------------------------------------ servers

const SCOPE = 'Project test · this window';

function invServer(index: number, repo: string, status = 'running', over: Partial<InventoryServer> = {}): InventoryServer {
  return {
    id: 900100 + index, repo, host: 'localhost', port: 4000 + index, status,
    startedAt: '2026-01-01T00:00:00.000Z', logPath: null, container: null, cwd: null, sandbox: null, ...over,
  };
}

function invShared(index: number, repo: string, status = 'running', over: Partial<SharedServer> = {}): SharedServer {
  return { ...invServer(index, repo, status), pinned: false, baseBranch: 'develop', dependents: [], ...over };
}

function invGroup(ticketId: number, servers: InventoryServer[], over: Partial<TicketServerGroup> = {}): TicketServerGroup {
  return {
    ticketId: 900200 + ticketId, key: `FEAT-${100 + ticketId}`, title: `Ticket ${ticketId + 1}`, stage: 'impl',
    archived: false, done: false, dependencyDown: false, downServices: [], servers, ...over,
  };
}

const dep = (n: number, done = false) => ({ ticketId: 900200 + n, key: `FEAT-${100 + n}`, title: `Ticket ${n + 1}`, done });

function mixedInventory(): ServerInventory {
  return {
    shared: [
      invShared(0, 'api', 'running', { pinned: true, dependents: [dep(0), dep(1, true)] }),
      invShared(1, 'web', 'running'),
      invShared(2, 'db', 'stopped', { baseBranch: 'main' }),
    ],
    tickets: [
      invGroup(0, [invServer(10, 'api/web'), invServer(11, 'worker', 'stopped')]),
      invGroup(1, [invServer(12, 'api/web')], { stage: 'done', done: true }),
      invGroup(2, [invServer(13, 'api/web', 'stopped')], { dependencyDown: true, downServices: ['db'] }),
    ],
  };
}

const serversFixture = (inventory: ServerInventory): ServersState => buildServersState(inventory, SCOPE);

function serversMixed(): ServersState {
  return serversFixture(mixedInventory());
}

function serversSharedOnly(): ServersState {
  return serversFixture({ shared: mixedInventory().shared, tickets: [] });
}

function serversTicketsOnly(): ServersState {
  return serversFixture({ shared: [], tickets: mixedInventory().tickets });
}

function serversDone(): ServersState {
  return serversFixture({
    shared: [invShared(0, 'api', 'running', { dependents: [dep(1, true)] })],
    tickets: [invGroup(1, [invServer(12, 'api/web'), invServer(14, 'worker')], { stage: 'done', done: true })],
  });
}

function serversArchived(): ServersState {
  return serversFixture({
    shared: [invShared(0, 'api', 'running')],
    tickets: [invGroup(3, [invServer(15, 'api/web')], { archived: true, done: true, stage: 'done' })],
  });
}

function serversIdle(): ServersState {
  return serversFixture({
    shared: [invShared(0, 'api'), invShared(1, 'web'), invShared(2, 'db', 'stopped')],
    tickets: [],
  });
}

function serversNone(): ServersState {
  return serversFixture({ shared: [], tickets: [] });
}

function serversUnavailable(): ServersState {
  return unavailableServersState('Open a project with a karst.yml to see its servers.', SCOPE);
}

function serversHostile(): ServersState {
  const long = 'Z'.repeat(120);
  return serversFixture({
    shared: [invShared(0, HOSTILE_LABEL, 'running', { baseBranch: 'release/' + long, dependents: [dep(0), dep(1, true)] })],
    tickets: [invGroup(0, [invServer(10, `api/${long}`), invServer(11, HOSTILE_LABEL, 'failed')], {
      key: 'FEAT-' + long, title: `${HOSTILE_LABEL} ${long}`, dependencyDown: true, downServices: [HOSTILE_LABEL, long],
    })],
  });
}

const BUILDERS: Readonly<Record<ResourcesScenario, () => ResourcesState>> = {
  unsupported: unsupportedState,
  degraded: degradedState,
  idle: idleState,
  busy: busyState,
  waste: wasteState,
  unattributed: unattributedState,
  hostile: hostileState,
  'servers-mixed': busyState,
  'servers-shared-only': busyState,
  'servers-tickets-only': busyState,
  'servers-done': busyState,
  'servers-archived': busyState,
  'servers-idle': idleState,
  'servers-none': idleState,
  'servers-unavailable': idleState,
  'servers-hostile': busyState,
};

const SERVERS: Readonly<Partial<Record<ResourcesScenario, () => ServersState>>> = {
  'servers-mixed': serversMixed,
  'servers-shared-only': serversSharedOnly,
  'servers-tickets-only': serversTicketsOnly,
  'servers-done': serversDone,
  'servers-archived': serversArchived,
  'servers-idle': serversIdle,
  'servers-none': serversNone,
  'servers-unavailable': serversUnavailable,
  'servers-hostile': serversHostile,
};

export function resourcesRenderFixtures(): ResourcesRenderFixture[] {
  return RESOURCES_SCENARIOS.map((scenario): ResourcesRenderFixture => {
    const servers = SERVERS[scenario];
    return servers
      ? { scenario, state: BUILDERS[scenario](), servers: servers(), tab: 'servers' }
      : { scenario, state: BUILDERS[scenario]() };
  });
}
