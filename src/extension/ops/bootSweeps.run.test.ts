import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sweepHookSettings: vi.fn(),
  reapStaleServers: vi.fn(),
  reconcileStageRuns: vi.fn(),
  reconcileProcessRuns: vi.fn(),
  reconcileShipRuns: vi.fn(),
  reconcileStrandedFixRounds: vi.fn(),
  compactArchivedWorktrees: vi.fn(),
  reapClosedGraphSubtrees: vi.fn(),
  reapOrphanedArtifactDirs: vi.fn(),
  getProjectBySlug: vi.fn(),
  getTicket: vi.fn(),
  allGraphRunsClosed: vi.fn(),
  pidAlive: vi.fn(),
  reconcileOnStart: vi.fn(),
  integrateAndReleaseParent: vi.fn(),
  isPortOpen: vi.fn(),
  removeContainer: vi.fn(),
  removeOrphanContainers: vi.fn(),
}));

vi.mock('../../agent/settingsSweep.js', () => ({ sweepHookSettings: m.sweepHookSettings }));
vi.mock('../../runtime/worktreeServers.js', () => ({ reapStaleServers: m.reapStaleServers, describeReap: (s: string) => `reap:${s}` }));
vi.mock('../../store/stageRuns.js', () => ({ reconcileStageRuns: m.reconcileStageRuns, describeStaleStageRun: (s: string) => `stage:${s}` }));
vi.mock('../../store/processRuns.js', () => ({ reconcileProcessRuns: m.reconcileProcessRuns, describeStaleProcessRun: (s: string) => `proc:${s}` }));
vi.mock('../../store/shipRuns.js', () => ({ reconcileShipRuns: m.reconcileShipRuns, describeStaleShipRun: (s: string) => `ship:${s}` }));
vi.mock('../../store/recoveryRounds.js', () => ({ reconcileStrandedFixRounds: m.reconcileStrandedFixRounds, describeStrandedFixRound: (s: { n: string }) => `fix:${s.n}` }));
vi.mock('../../runtime/archiveBulk.js', () => ({ compactArchivedWorktrees: m.compactArchivedWorktrees }));
vi.mock('../../approaches/graph/retention.js', () => ({ reapClosedGraphSubtrees: m.reapClosedGraphSubtrees, describeGraphReap: (s: string) => `graph:${s}` }));
vi.mock('../../runtime/artifactOrphans.js', () => ({ reapOrphanedArtifactDirs: m.reapOrphanedArtifactDirs, describeArtifactReap: (s: number) => `art:${s}` }));
vi.mock('../../store/projects.js', () => ({ getProjectBySlug: m.getProjectBySlug }));
vi.mock('../../store/tickets.js', () => ({ getTicket: m.getTicket }));
vi.mock('../../store/graph/graphRuns.js', () => ({ allGraphRunsClosed: m.allGraphRunsClosed }));
vi.mock('../../runtime/pidAlive.js', () => ({ pidAlive: m.pidAlive }));
vi.mock('../../recovery/reconcile.js', () => ({ reconcileOnStart: m.reconcileOnStart }));
vi.mock('../../workflow/subtaskIntegration.js', () => ({ integrateAndReleaseParent: m.integrateAndReleaseParent }));
vi.mock('../../runtime/portConflict.js', () => ({ isPortOpen: m.isPortOpen }));
vi.mock('../../runtime/dockerContainer.js', () => ({ removeContainer: m.removeContainer }));
vi.mock('../../runtime/orphanContainers.js', () => ({ removeOrphanContainers: m.removeOrphanContainers }));

import { runBootSweeps } from './bootSweeps.js';

let rows: unknown[];
let container: string | null;
const store = {
  db: {
    prepare: (sql: string) => ({
      all: () => (sql.includes('FROM servers WHERE status') ? rows : []),
      get: () => ({ container }),
    }),
  },
} as never;

function deps() {
  return { store, globalStorageRoot: '/g', info: vi.fn(), debug: vi.fn(), logError: vi.fn() };
}

beforeEach(() => {
  vi.resetAllMocks();
  rows = [];
  container = null;
  m.sweepHookSettings.mockReturnValue(0);
  m.reapStaleServers.mockReturnValue([]);
  m.reconcileStageRuns.mockReturnValue([]);
  m.reconcileProcessRuns.mockReturnValue([]);
  m.reconcileShipRuns.mockReturnValue([]);
  m.reconcileStrandedFixRounds.mockReturnValue([]);
  m.compactArchivedWorktrees.mockResolvedValue({ compacted: 0, sweep: { prunedBranches: 0, prunedArchiveRefs: 0 } });
  m.reapClosedGraphSubtrees.mockReturnValue({ removed: [] });
  m.reapOrphanedArtifactDirs.mockReturnValue({ removed: [] });
  m.reconcileOnStart.mockReturnValue({ deadServers: [], awaitingSubtaskParents: [] });
  m.removeOrphanContainers.mockResolvedValue({ removed: [], failed: [] });
});

describe('runBootSweeps', () => {
  it('is silent and resolves no fix resumes when nothing is stale', async () => {
    const d = deps();
    const r = await runBootSweeps(d);
    expect(d.info).not.toHaveBeenCalled();
    expect(d.logError).not.toHaveBeenCalled();
    expect(r.strandedFixResumes.size).toBe(0);
    expect(m.sweepHookSettings).toHaveBeenCalledWith('/g');
  });

  it('reports swept hook settings only when some were swept', async () => {
    m.sweepHookSettings.mockReturnValue(3);
    const d = deps();
    await runBootSweeps(d);
    expect(d.info).toHaveBeenCalledWith('karst: swept 3 stale hook-settings file(s)');
  });

  it('logs a failed hook-settings sweep and carries on', async () => {
    const err = new Error('x');
    m.sweepHookSettings.mockImplementation(() => { throw err; });
    const d = deps();
    await runBootSweeps(d);
    expect(d.logError).toHaveBeenCalledWith('karst: hook-settings sweep failed', err);
    expect(m.reapStaleServers).toHaveBeenCalled();
  });

  it('reports reaped servers and forwards the debug sink', async () => {
    m.reapStaleServers.mockImplementation((_s: unknown, o: { debug: (x: string) => void }) => { o.debug('dbg'); return ['a', 'b']; });
    const d = deps();
    await runBootSweeps(d);
    expect(d.info.mock.calls.map((c) => c[0])).toEqual(['reap:a', 'reap:b']);
    expect(d.debug).toHaveBeenCalledWith('dbg');
  });

  it('logs a failed stale-server sweep', async () => {
    const err = new Error('s');
    m.reapStaleServers.mockImplementation(() => { throw err; });
    const d = deps();
    await runBootSweeps(d);
    expect(d.logError).toHaveBeenCalledWith('karst: stale-server sweep failed', err);
  });

  it('retires dead servers: removes the container and says which ticket', async () => {
    container = 'karst-t1-web';
    m.reconcileOnStart.mockReturnValue({
      deadServers: [{ id: 7, service: 'web', pid: 42, ticketId: 5 }, { id: 8, service: 'db', pid: null, ticketId: null }],
      awaitingSubtaskParents: [],
    });
    const d = deps();
    await runBootSweeps(d);
    expect(m.removeContainer).toHaveBeenCalledTimes(2);
    expect(m.removeContainer).toHaveBeenCalledWith('karst-t1-web');
    const lines = d.info.mock.calls.map((c) => c[0] as string);
    expect(lines[0]).toBe("karst: 'web' is no longer running (pid 42) on ticket T5 — marked offline.");
    expect(lines[1]).toBe("karst: 'db' is no longer running (pid unknown) — marked offline.");
  });

  it('removes no container when the row names none', async () => {
    m.reconcileOnStart.mockReturnValue({ deadServers: [{ id: 7, service: 'web', pid: 1, ticketId: null }], awaitingSubtaskParents: [] });
    await runBootSweeps(deps());
    expect(m.removeContainer).not.toHaveBeenCalled();
  });

  it('treats a dead pid with a bound port as alive, skips live and address-less rows', async () => {
    rows = [
      { pid: 1, host: 'h', port: 1 }, // alive
      { pid: 2, host: null, port: 2 },
      { pid: 3, host: 'h', port: null },
      { pid: 4, host: 'h', port: 4 }, // port open
      { pid: 5, host: 'h', port: 5 }, // port closed
    ];
    m.pidAlive.mockImplementation((p: number) => p === 1);
    m.isPortOpen.mockImplementation(async (_h: string, p: number) => p === 4);
    let isAlive: (pid: number) => boolean = () => false;
    m.reconcileOnStart.mockImplementation((_s: unknown, f: (pid: number) => boolean) => { isAlive = f; return { deadServers: [], awaitingSubtaskParents: [] }; });
    await runBootSweeps(deps());
    expect(m.isPortOpen.mock.calls).toEqual([['h', 4], ['h', 5]]);
    expect(isAlive(4)).toBe(true);
    expect(isAlive(1)).toBe(true);
    expect(isAlive(5)).toBe(false);
    expect(isAlive(2)).toBe(false);
  });

  it('reports orphan containers removed and failed', async () => {
    m.removeOrphanContainers.mockImplementation(async (_s: unknown, o: { debug: (x: string) => void }) => { o.debug('od'); return { removed: ['r1'], failed: ['f1'] }; });
    const d = deps();
    await runBootSweeps(d);
    expect(d.info.mock.calls.map((c) => c[0])).toEqual(['karst: removed orphan container r1', 'karst: could not remove orphan container f1']);
    expect(d.debug).toHaveBeenCalledWith('od');
  });

  it('integrates each awaiting-subtask parent and forwards debug', async () => {
    m.reconcileOnStart.mockReturnValue({ deadServers: [], awaitingSubtaskParents: [11, 12] });
    m.integrateAndReleaseParent.mockImplementation(async (_s: unknown, _id: number, _g: unknown, dbg: (x: string) => void) => { dbg('int'); });
    const d = deps();
    await runBootSweeps(d);
    expect(m.integrateAndReleaseParent.mock.calls.map((c) => c[1])).toEqual([11, 12]);
    expect(d.debug).toHaveBeenCalledWith('int');
  });

  it('logs a failed boot reconcile and still runs later sweeps', async () => {
    const err = new Error('r');
    m.reconcileOnStart.mockImplementation(() => { throw err; });
    const d = deps();
    await runBootSweeps(d);
    expect(d.logError).toHaveBeenCalledWith('karst: boot reconcile failed', err);
    expect(m.reconcileStageRuns).toHaveBeenCalled();
  });

  it('reports stale stage, process and ship runs, passing pidAlive', async () => {
    m.reconcileStageRuns.mockReturnValue(['s']);
    m.reconcileProcessRuns.mockReturnValue(['p']);
    m.reconcileShipRuns.mockReturnValue(['h']);
    const d = deps();
    await runBootSweeps(d);
    expect(d.info.mock.calls.map((c) => c[0])).toEqual(['stage:s', 'proc:p', 'ship:h']);
    expect(m.reconcileStageRuns).toHaveBeenCalledWith(store, m.pidAlive);
    expect(m.reconcileProcessRuns).toHaveBeenCalledWith(store, m.pidAlive);
    expect(m.reconcileShipRuns).toHaveBeenCalledWith(store, m.pidAlive, expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
  });

  it.each([
    ['reconcileStageRuns', 'karst: stale gate-run sweep failed'],
    ['reconcileProcessRuns', 'karst: stale process-run sweep failed'],
    ['reconcileShipRuns', 'karst: stale ship-run sweep failed'],
    ['reconcileStrandedFixRounds', 'karst: stranded fix-round sweep failed'],
    ['compactArchivedWorktrees', 'karst: auto-compact failed'],
    ['reapClosedGraphSubtrees', 'karst: graph byte-subtree sweep failed'],
    ['reapOrphanedArtifactDirs', 'karst: artifact-dir orphan sweep failed'],
  ] as const)('%s throwing is logged, not fatal', async (fn, msg) => {
    const err = new Error(fn);
    m[fn].mockImplementation(() => { throw err; });
    const d = deps();
    await expect(runBootSweeps(d)).resolves.toBeDefined();
    expect(d.logError).toHaveBeenCalledWith(msg, err);
  });

  it('collects only execution-kind stranded fix rounds for resume', async () => {
    m.reconcileStrandedFixRounds.mockReturnValue([{ n: 'a', kind: 'execution', ticketId: 3 }, { n: 'b', kind: 'other', ticketId: 4 }]);
    const d = deps();
    const r = await runBootSweeps(d);
    expect([...r.strandedFixResumes]).toEqual([3]);
    expect(d.info.mock.calls.map((c) => c[0])).toEqual(['fix:a', 'fix:b']);
    expect(m.reconcileStrandedFixRounds).toHaveBeenCalledWith(store, expect.stringMatching(/^\d{4}-/));
  });

  it.each([
    [{ compacted: 2, sweep: { prunedBranches: 0, prunedArchiveRefs: 0 } }, 'karst: auto-compact compacted 2 archive(s), swept 0 orphan branch(es), 0 orphan ref(s)'],
    [{ compacted: 0, sweep: { prunedBranches: 3, prunedArchiveRefs: 0 } }, 'karst: auto-compact compacted 0 archive(s), swept 3 orphan branch(es), 0 orphan ref(s)'],
    [{ compacted: 0, sweep: { prunedBranches: 0, prunedArchiveRefs: 4 } }, 'karst: auto-compact compacted 0 archive(s), swept 0 orphan branch(es), 4 orphan ref(s)'],
  ])('auto-compact reports when any count is non-zero', async (res, line) => {
    m.compactArchivedWorktrees.mockResolvedValue(res);
    const d = deps();
    await runBootSweeps(d);
    expect(d.info).toHaveBeenCalledWith(line);
    expect(m.compactArchivedWorktrees).toHaveBeenCalledWith(expect.anything(), store, 7 * 24 * 60 * 60 * 1000);
  });

  it('graph sweep: ticketExists needs project match, tolerates unknown project/ticket; reports removals', async () => {
    m.allGraphRunsClosed.mockReturnValue(true);
    m.reapClosedGraphSubtrees.mockImplementation((root: string, p: { ticketExists: (s: string, t: number) => boolean; allGraphRunsClosed: (t: number) => boolean }) => {
      expect(root).toBe('/g/graph');
      m.getProjectBySlug.mockReturnValueOnce(undefined);
      expect(p.ticketExists('x', 1)).toBe(false);
      m.getProjectBySlug.mockReturnValueOnce({ id: 9 });
      m.getTicket.mockReturnValueOnce({ projectId: 9 });
      expect(p.ticketExists('x', 1)).toBe(true);
      m.getProjectBySlug.mockReturnValueOnce({ id: 9 });
      m.getTicket.mockReturnValueOnce({ projectId: 8 });
      expect(p.ticketExists('x', 1)).toBe(false);
      m.getProjectBySlug.mockReturnValueOnce({ id: 9 });
      m.getTicket.mockImplementationOnce(() => { throw new Error('gone'); });
      expect(p.ticketExists('x', 1)).toBe(false);
      expect(p.allGraphRunsClosed(5)).toBe(true);
      return { removed: ['g1'] };
    });
    const d = deps();
    await runBootSweeps(d);
    expect(m.allGraphRunsClosed).toHaveBeenCalledWith((store as { db: unknown }).db, 5);
    expect(d.info).toHaveBeenCalledWith('graph:g1');
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('artifact sweep: ticketExists reflects getTicket; reports removals', async () => {
    m.reapOrphanedArtifactDirs.mockImplementation((root: string, p: { ticketExists: (t: number) => boolean }) => {
      expect(root).toBe('/g/artifacts');
      expect(p.ticketExists(1)).toBe(true);
      m.getTicket.mockImplementationOnce(() => { throw new Error('gone'); });
      expect(p.ticketExists(2)).toBe(false);
      return { removed: [77] };
    });
    const d = deps();
    await runBootSweeps(d);
    expect(d.info).toHaveBeenCalledWith('art:77');
    expect(d.logError).not.toHaveBeenCalled();
  });
});
