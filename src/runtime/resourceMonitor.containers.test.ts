import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { projectPrefix } from '../agent/sandboxInventory.js';
import type { ProcessResult, SbxProcess } from '../agent/sbx/sbxProcess.js';
import { parseProcTable } from './procSnapshot.js';
import { ResourceMonitor } from './resourceMonitor.js';
import type { RemoteWorkspaceSample } from './containerSampler.js';
import type { AttributedRow } from './resourceInventory.js';

const ROOT = '/proj';
const P = projectPrefix(ROOT);
const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: '' });
const SNAP = `1 0 10 0:01.00 Tue Aug 12 10:33:21 2026 /sbin/launchd
10 1 1024 0:01.00 Tue Aug 12 10:33:21 2026 /x/com.docker.virtualization`;
const STATS = JSON.stringify({ Name: `${P}7-claude`, CPUPerc: '8%', MemUsage: '100KiB / 1GiB' });

describe('ResourceMonitor containers', () => {
  let store: Store;
  beforeEach(() => {
    vi.useFakeTimers();
    store = openStore(':memory:');
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  const make = (docker: SbxProcess): ResourceMonitor =>
    new ResourceMonitor({
      store,
      projectId: () => undefined,
      worktreeRoots: () => [],
      readSnapshot: async () => ({ supported: true, snapshot: parseProcTable(SNAP, 1000) }),
      docker,
      projectRoot: () => ROOT,
      cpuCoreCount: 4,
    });

  it('samples containers on the slow lane and surfaces a row plus the VM residual', async () => {
    const docker: SbxProcess = { run: async (_c, a) => ok(a[0] === 'ps' ? `${P}7-claude` : STATS) };
    const m = make(docker);
    await m.refreshNow();
    await vi.waitFor(() => expect(m.reading().inventory?.attributed.some((r) => r.kind === 'container')).toBe(true));
    const inv = m.reading().inventory!;
    expect(inv.vmOverhead).toMatchObject({ rssBytes: 1024 * 1024 - 100 * 1024 });
    expect(m.reading().containersDegraded).toBe(false);
    m.dispose();
  });

  it('never samples containers from the fast lane', async () => {
    const run = vi.fn(async () => ok(''));
    const m = make({ run });
    m.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run).not.toHaveBeenCalled();
    m.dispose();
  });

  it('is single-flight and keeps the previous reading when the daemon goes down', async () => {
    let down = false;
    const run = vi.fn(async (_c: string, a: readonly string[]) =>
      down ? ({ code: 1, stdout: '', stderr: 'x' } as ProcessResult) : ok(a[0] === 'ps' ? `${P}7-claude` : STATS),
    );
    const m = make({ run });
    await m.refreshNow();
    await vi.waitFor(() => expect(m.reading().inventory?.attributed.some((r) => r.kind === 'container')).toBe(true));
    down = true;
    await m.refreshContainers();
    expect(m.reading().containersDegraded).toBe(true);
    expect(m.reading().inventory!.attributed.some((r) => r.kind === 'container')).toBe(true);
    down = false;
    run.mockClear();
    await Promise.all([m.refreshContainers(), m.refreshContainers()]);
    expect(run.mock.calls.filter((c) => c[1][0] === 'ps')).toHaveLength(1);
    m.dispose();
  });

  it('does nothing without a docker seam', async () => {
    const m = new ResourceMonitor({ store, projectId: () => undefined, worktreeRoots: () => [], readSnapshot: async () => ({ supported: true, snapshot: parseProcTable(SNAP, 1) }) });
    await m.refreshNow();
    await m.refreshContainers();
    expect(m.reading().inventory?.vmOverhead).toBeUndefined();
    m.dispose();
  });

  it('shows no banner and no rows when docker is not installed', async () => {
    const m = make({ run: async () => ({ code: 127, stdout: '', stderr: '' }) });
    await m.refreshNow();
    await m.refreshContainers();
    expect(m.reading().containersDegraded).toBe(false);
    expect(m.reading().inventory!.attributed.some((r) => r.kind === 'container')).toBe(false);
    m.dispose();
  });

  it('drops a stale container reading after repeated failures', async () => {
    let t = 1_000_000;
    let down = false;
    const run = async (_c: string, a: readonly string[]): Promise<ProcessResult> =>
      down ? { code: 1, stdout: '', stderr: 'x' } : ok(a[0] === 'ps' ? `${P}7-claude` : STATS);
    const m = new ResourceMonitor({
      store, projectId: () => undefined, worktreeRoots: () => [], now: () => t,
      readSnapshot: async () => ({ supported: true, snapshot: parseProcTable(SNAP, 1000) }),
      docker: { run }, projectRoot: () => ROOT, cpuCoreCount: 4,
    });
    await m.refreshNow();
    await vi.waitFor(() => expect(m.reading().inventory?.attributed.some((r) => r.kind === 'container')).toBe(true));
    down = true;
    t += 60_000;
    await m.refreshContainers();
    expect(m.reading().inventory!.attributed.some((r) => r.kind === 'container')).toBe(true);
    t += 60_000;
    await m.refreshContainers();
    expect(m.reading().inventory!.attributed.some((r) => r.kind === 'container')).toBe(false);
    expect(m.reading().containersDegraded).toBe(true);
    m.dispose();
  });
});

describe('ResourceMonitor remote workspaces (D824, edit 7)', () => {
  let store: Store;
  beforeEach(() => {
    vi.useFakeTimers();
    store = openStore(':memory:');
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  const row = (ticketId: number, label: string): AttributedRow => ({
    pid: 0, kind: 'remote', ticketId, label, serverId: null, attribution: 'attributable', cost: null, cwd: null, comm: `ws-${ticketId}`,
  });
  const make = (remoteWorkspaces: () => Promise<RemoteWorkspaceSample>): ResourceMonitor =>
    new ResourceMonitor({
      store, projectId: () => undefined, worktreeRoots: () => [],
      readSnapshot: async () => ({ supported: true, snapshot: parseProcTable(SNAP, 1000) }),
      cpuCoreCount: 4, remoteWorkspaces,
    });
  const remoteRows = (m: ResourceMonitor): readonly AttributedRow[] =>
    m.reading().inventory?.attributed.filter((r) => r.kind === 'remote') ?? [];

  it('adds the remote rows while the panel is open, and they never count in the totals', async () => {
    const sample = vi.fn(async (): Promise<RemoteWorkspaceSample> => ({ rows: new Map([['devbox', [row(7, 'ssh devbox · stopped · disk unknown')]]]), failed: new Set() }));
    const m = make(sample);
    await m.refreshNow();
    const totals = m.reading().inventory!.totals;
    m.setPanelVisible(true);
    await vi.waitFor(() => expect(remoteRows(m)).toHaveLength(1));
    expect(m.reading().inventory!.totals).toEqual(totals);
    m.dispose();
  });

  it('never lists a remote while the panel is closed', async () => {
    const sample = vi.fn(async (): Promise<RemoteWorkspaceSample> => ({ rows: new Map(), failed: new Set() }));
    const m = make(sample);
    m.start();
    await m.refreshNow();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(sample).not.toHaveBeenCalled();
    m.dispose();
  });

  it('keeps the previous rows of a remote whose listing failed, and drops the rows of one that listed none', async () => {
    let next: RemoteWorkspaceSample = {
      rows: new Map([['a', [row(7, 'ssh a')]], ['b', [row(8, 'ssh b')]]]), failed: new Set(),
    };
    const m = make(async () => next);
    await m.refreshNow();
    await m.refreshRemoteWorkspaces();
    expect(remoteRows(m).map((r) => r.label)).toEqual(['ssh a', 'ssh b']);
    next = { rows: new Map([['b', []]]), failed: new Set(['a']) };
    await m.refreshRemoteWorkspaces();
    expect(remoteRows(m).map((r) => r.label)).toEqual(['ssh a']);
    m.dispose();
  });

  it('is single-flight and logs a thrown sample without losing the rows', async () => {
    let calls = 0;
    let fail = false;
    const logError = vi.fn();
    const m = new ResourceMonitor({
      store, projectId: () => undefined, worktreeRoots: () => [], logError, cpuCoreCount: 4,
      readSnapshot: async () => ({ supported: true, snapshot: parseProcTable(SNAP, 1000) }),
      remoteWorkspaces: async () => {
        calls += 1;
        if (fail) throw new Error('boom');
        return { rows: new Map([['a', [row(7, 'ssh a')]]]), failed: new Set() };
      },
    });
    await m.refreshNow();
    await Promise.all([m.refreshRemoteWorkspaces(), m.refreshRemoteWorkspaces()]);
    expect(calls).toBe(1);
    fail = true;
    await m.refreshRemoteWorkspaces();
    expect(logError).toHaveBeenCalledWith('resource monitor remote workspace sample failed', expect.any(Error));
    expect(remoteRows(m)).toHaveLength(1);
    m.dispose();
  });
});
