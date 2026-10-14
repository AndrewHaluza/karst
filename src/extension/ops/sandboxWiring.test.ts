import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { archiveTicket, createTicket, getTicket, setSessionId } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { REMOVE_ANYWAY, REMOVE_ORPHANS } from './sandboxLifecycleOps.js';
import { makeSandboxWiring, type SandboxWiringInput } from './sandboxWiring.js';

let store: Store;
let id: number;
beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'K-1', title: 't' }).id;
  setSessionId(store, id, 's1', 'claude');
});

function wiring(over: Partial<SandboxWiringInput> = {}) {
  const notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) };
  const choose = vi.fn(async () => undefined);
  const w = makeSandboxWiring({
    store, notify, choose, projectRoot: () => '/p/karst.yml', backendOn: () => false, projectId: () => undefined,
    owned: new Set([id]), bridges: () => undefined, openSyncDiff: vi.fn(async () => {}), info: vi.fn(), logError: vi.fn(), ...over,
  });
  return { w, notify, choose };
}

describe('makeSandboxWiring with no sandbox backend', () => {
  it('every lifecycle hook is a no-op that never blocks', async () => {
    const { w, notify, choose } = wiring();
    await expect(w.beforeArchive(id)).resolves.toBe(true);
    await expect(w.onProviderSwitch(id, 'opencode')).resolves.toBe(true);
    w.onDone(id);
    await w.reconcile();
    expect(getTicket(store, id).sessionId).toBe('s1');
    expect(choose).not.toHaveBeenCalled();
    expect(notify.warn).not.toHaveBeenCalled();
  });
  it('orphan cleanup says no backend', async () => {
    const { w, notify } = wiring({ backendOn: () => true });
    await w.cleanupOrphans();
    expect(notify.info).toHaveBeenCalledWith('Karst: no sandbox backend configured.');
  });
  it('a missing project root disables the hooks even with a backend', async () => {
    const { w } = wiring({ backendOn: () => true, projectRoot: () => undefined, projectId: () => 1 });
    await expect(w.beforeArchive(id)).resolves.toBe(true);
    await w.reconcile();
    expect(getTicket(store, id).sessionId).toBe('s1');
  });
});

describe('makeSandboxWiring manual commands', () => {
  it('sync/dispose name the ticket and report a missing worktree', async () => {
    const { w, notify } = wiring();
    await w.sync(id);
    await w.dispose(id);
    expect(notify.error.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'Karst: K-1 has no worktree branch to sync into.',
      'Karst: cannot remove the sandbox for K-1 yet: the hook endpoint is still starting. Try again.',
    ]);
  });
});

describe('makeSandboxWiring with a backend (host core → no sandbox work)', () => {
  it('provider switch drops the session id; archive of a host-core ticket passes', async () => {
    setSessionId(store, id, 's1', 'antigravity');
    const { w } = wiring({ backendOn: () => true });
    await expect(w.beforeArchive(id)).resolves.toBe(true);
    await expect(w.onProviderSwitch(id, 'opencode2')).resolves.toBe(true);
    expect(getTicket(store, id).sessionId).toBeNull();
  });
});

describe('makeSandboxWiring with a backend and fake processes', () => {
  const ROOT = '/p/karst.yml';
  function live() {
    const projectId = upsertProject(store, { slug: 'p' }).id;
    const a = createTicket(store, { key: 'A-1', title: 'a', projectId }).id;
    const b = createTicket(store, { key: 'A-2', title: 'b', projectId }).id;
    const gone = createTicket(store, { key: 'A-3', title: 'c', projectId }).id;
    archiveTicket(store, gone);
    for (const t of [a, b]) setSessionId(store, t, `s${t}`, 'claude');
    const ls = `SANDBOX AGENT STATUS\n${sbxName({ projectRoot: ROOT, ticketId: a, core: 'claude' })} claude running\n${sbxName({ projectRoot: ROOT, ticketId: gone, core: 'claude' })} claude stopped\n`;
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: ls } });
    const dockerProc = Object.assign(fakeSbxProcess(), { pipe: vi.fn() });
    return { projectId, a, b, gone, proc, dockerProc };
  }

  it('reconcile drops only the missing owned sandbox session; logs the orphan', async () => {
    const { projectId, a, b, gone, proc, dockerProc } = live();
    const info = vi.fn();
    const { w } = wiring({ backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, owned: new Set([a, b]), proc, dockerProc, info });
    await w.reconcile();
    expect(getTicket(store, a).sessionId).toBe(`s${a}`);
    expect(getTicket(store, b).sessionId).toBeNull();
    expect(info.mock.calls.map((c: unknown[]) => c[0]).join('\n')).toContain(`belongs to ticket ${gone}, which is not live`);
  });

  it('orphan cleanup removes only the archived ticket sandbox after confirm', async () => {
    const { projectId, gone, proc, dockerProc } = live();
    const { w, choose } = wiring({ backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, proc, dockerProc });
    choose.mockResolvedValue(REMOVE_ORPHANS as never);
    await w.cleanupOrphans();
    const rms = proc.calls.filter((c) => c.args[0] === 'rm').map((c) => c.args.at(-1));
    expect(rms).toEqual([sbxName({ projectRoot: ROOT, ticketId: gone, core: 'claude' })]);
  });

  it('archive of a running sandbox syncs, disposes and removes its bridge; done stops it', async () => {
    const { projectId, a, proc, dockerProc } = live();
    const bridges = { dispose: vi.fn(async () => {}) };
    // No worktree in this store → sync cannot run → the user's "Remove anyway" is required.
    const { w, choose } = wiring({ backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, owned: new Set([a]), proc, dockerProc, bridges: () => bridges });
    choose.mockResolvedValue(REMOVE_ANYWAY as never);
    w.onDone(a);
    await vi.waitFor(() => expect(proc.calls.some((c) => c.args.join(' ') === `stop ${sbxName({ projectRoot: ROOT, ticketId: a, core: 'claude' })}`)).toBe(true));
    await expect(w.beforeArchive(a)).resolves.toBe(true);
    expect(bridges.dispose).toHaveBeenCalledWith(a);
    expect(proc.calls.some((c) => c.args[0] === 'rm')).toBe(true);
  });

  it('provider switch to a docker core removes the sbx sandbox and drops the session', async () => {
    const { projectId, a, proc, dockerProc } = live();
    const { w, choose } = wiring({ backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, owned: new Set([a]), proc, dockerProc });
    choose.mockResolvedValue(REMOVE_ANYWAY as never);
    await expect(w.onProviderSwitch(a, 'opencode')).resolves.toBe(true);
    expect(getTicket(store, a).sessionId).toBeNull();
    expect(proc.calls.some((c) => c.args[0] === 'rm')).toBe(true);
  });

  it('manual sync with a project root uses it for the sandbox name', async () => {
    const { a } = live();
    const { w, notify } = wiring({ projectRoot: () => undefined });
    await w.sync(a);
    expect(notify.error).toHaveBeenCalledWith('Karst: A-1 has no worktree branch to sync into.');
  });
});
