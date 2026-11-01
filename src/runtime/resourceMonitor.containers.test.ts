import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { projectPrefix } from '../agent/sandboxInventory.js';
import type { ProcessResult, SbxProcess } from '../agent/sbx/sbxProcess.js';
import { parseProcTable } from './procSnapshot.js';
import { ResourceMonitor } from './resourceMonitor.js';

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
});
