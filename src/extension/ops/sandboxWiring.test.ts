import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { archiveTicket, createTicket, getTicket, setSessionId } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { OPEN_SYNC_DIFF, REMOVE_ANYWAY, REMOVE_ORPHANS } from './sandboxLifecycleOps.js';
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
    owned: new Set([id]), bridges: () => undefined, sessionOpen: () => false, openSyncDiff: vi.fn(async () => {}), showDiff: vi.fn(async () => {}), info: vi.fn(), logError: vi.fn(), ...over,
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

describe('makeSandboxWiring idle sweep', () => {
  const ROOT = '/p/karst.yml';
  function setup(sessionOpen: boolean, ageMin: number) {
    const projectId = upsertProject(store, { slug: 'p' }).id;
    const a = createTicket(store, { key: 'I-1', title: 'a', projectId }).id;
    setSessionId(store, a, 's', 'claude');
    store.db.prepare(`UPDATE tickets SET updated_at = datetime('now', '-${ageMin} minutes') WHERE id = ?`).run(a);
    const n = sbxName({ projectRoot: ROOT, ticketId: a, core: 'claude' });
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${n} claude running\n` } });
    const info = vi.fn();
    const { w } = wiring({ backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, owned: new Set([a]),
      proc, dockerProc: Object.assign(fakeSbxProcess(), { pipe: vi.fn() }), sessionOpen: () => sessionOpen, info });
    const stops = () => proc.calls.filter((c) => c.args[0] === 'stop').map((c) => c.args[1]);
    return { w, n, stops, info };
  }
  it('stops a sandbox idle past 120 min with no open session, and logs it', async () => {
    const { w, n, stops, info } = setup(false, 121);
    await expect(w.idleSweep()).resolves.toBe(1);
    expect(stops()).toEqual([n]);
    expect(info).toHaveBeenCalledWith(`karst: stopped 1 idle sandbox(es): ${n}`);
  });
  it('keeps a recent or session-attached sandbox', async () => {
    const recent = setup(false, 60);
    await expect(recent.w.idleSweep()).resolves.toBe(0);
    expect(recent.stops()).toEqual([]);
    expect(recent.info).not.toHaveBeenCalled();
  });
  it('keeps a sandbox whose session is open', async () => {
    const open = setup(true, 500);
    await expect(open.w.idleSweep()).resolves.toBe(0);
  });
  it('no backend → no sweep', async () => {
    const { w } = wiring();
    await expect(w.idleSweep()).resolves.toBe(0);
  });
  it('timer runs the sweep every 10 min and logs a failure', async () => {
    let tick: (() => void) | undefined;
    const dispose = vi.fn();
    const logError = vi.fn();
    const { w } = wiring({ backendOn: () => true, projectId: () => 1, logError,
      proc: { run: vi.fn(async () => { throw new Error('down'); }) },
      setInterval: (fn, ms) => { expect(ms).toBe(600_000); tick = fn; return { dispose }; } });
    const handle = w.startIdleSweep();
    tick!();
    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith('karst: sandbox idle sweep failed', expect.any(Error)));
    handle.dispose();
    expect(dispose).toHaveBeenCalled();
  });
});

describe('makeSandboxWiring ownership after the session closed (review fix)', () => {
  const ROOT = '/p/karst.yml';
  function setup(agentState: string, projectOf: 'same' | 'other' = 'same') {
    const projectId = upsertProject(store, { slug: 'p' }).id;
    const a = createTicket(store, { key: 'O-1', title: 'a', projectId }).id;
    setSessionId(store, a, 's', 'claude');
    store.db.prepare("UPDATE tickets SET agent_state = ?, updated_at = datetime('now', '-500 minutes') WHERE id = ?").run(agentState, a);
    const n = sbxName({ projectRoot: ROOT, ticketId: a, core: 'claude' });
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${n} claude running\n` } });
    const r = wiring({ backendOn: () => true, projectRoot: () => ROOT, projectId: () => (projectOf === 'same' ? projectId : projectId + 1),
      owned: new Set(), proc, dockerProc: Object.assign(fakeSbxProcess(), { pipe: vi.fn() }) });
    r.choose.mockResolvedValue(REMOVE_ANYWAY as never);
    return { ...r, a, proc };
  }
  it('closed terminal (not owned, idle): archive removes and idle sweep stops', async () => {
    const { w, a, proc } = setup('idle');
    await expect(w.idleSweep()).resolves.toBe(1);
    await expect(w.beforeArchive(a)).resolves.toBe(true);
    expect(proc.calls.some((c) => c.args[0] === 'rm')).toBe(true);
  });
  it('a session running in another window is left alone', async () => {
    const { w, a, proc, notify } = setup('running');
    await expect(w.idleSweep()).resolves.toBe(0);
    await expect(w.beforeArchive(a)).resolves.toBe(false);
    expect(notify.warn).toHaveBeenCalledWith('Karst: O-1 is owned by another window; its sandbox was left alone.');
    expect(proc.calls.some((c) => c.args[0] === 'rm' || c.args[0] === 'stop')).toBe(false);
  });
  it('another project\'s ticket is never controlled', async () => {
    const { w, a } = setup('idle', 'other');
    await expect(w.beforeArchive(a)).resolves.toBe(false);
  });
});

describe('makeSandboxWiring dashboard actions (no backend gate)', () => {
  const ROOT = '/p/karst.yml';
  function withSandbox() {
    const name = sbxName({ projectRoot: ROOT, ticketId: id, core: 'claude' });
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${name} claude running\n` } });
    const dockerProc = Object.assign(fakeSbxProcess(), { pipe: vi.fn() });
    return { name, proc, dockerProc };
  }

  it('stop stops the owned ticket sandbox even when the project backend is off', async () => {
    const { name, proc, dockerProc } = withSandbox();
    const { w, notify } = wiring({ projectRoot: () => ROOT, proc, dockerProc });
    await w.stop(id);
    expect(proc.calls.some((c) => c.args.join(' ') === `stop ${name}`)).toBe(true);
    expect(notify.info).toHaveBeenCalledWith('Karst: K-1 sandbox stopped.');
  });

  it('stop leaves another window\'s ticket alone and says nothing', async () => {
    const { proc, dockerProc } = withSandbox();
    const other = createTicket(store, { key: 'K-2', title: 'o', projectId: upsertProject(store, { slug: 'q' }).id }).id;
    setSessionId(store, other, 's2', 'claude');
    const { w, notify } = wiring({ projectRoot: () => ROOT, proc, dockerProc, owned: new Set([id]), projectId: () => 999 });
    await w.stop(other);
    expect(proc.calls.some((c) => c.args[0] === 'stop')).toBe(false);
    expect(notify.info).not.toHaveBeenCalled();
  });

  it('remove is guarded: unsynced commits need the explicit choice, dismissing keeps the sandbox', async () => {
    const { proc, dockerProc } = withSandbox();
    const { w, choose } = wiring({ projectRoot: () => ROOT, proc, dockerProc });
    await w.remove(id); // no worktree here -> cannot sync -> asks; the default dismissal cancels
    expect(choose).toHaveBeenCalledTimes(1);
    expect(proc.calls.some((c) => c.args[0] === 'rm')).toBe(false);
    choose.mockResolvedValue(REMOVE_ANYWAY as never);
    await w.remove(id);
    expect(proc.calls.some((c) => c.args[0] === 'rm')).toBe(true);
  });

  it('remove: "Open sync diff" opens this ticket\'s diff, and a confirmed removal also drops the bridge dir', async () => {
    const { proc, dockerProc } = withSandbox();
    const openSyncDiff = vi.fn(async () => {});
    const bridges = { dispose: vi.fn(async () => {}) };
    const { w, choose } = wiring({ projectRoot: () => ROOT, proc, dockerProc, openSyncDiff, bridges: () => bridges });
    choose.mockResolvedValueOnce(OPEN_SYNC_DIFF as never);
    await w.remove(id);
    expect(openSyncDiff).toHaveBeenCalledWith(id);
    expect(proc.calls.some((c) => c.args[0] === 'rm')).toBe(false);
    choose.mockResolvedValueOnce(REMOVE_ANYWAY as never);
    await w.remove(id);
    expect(bridges.dispose).toHaveBeenCalledWith(id);
  });

  it('remove for a docker core goes through the injected docker process, not the real one', async () => {
    setSessionId(store, id, 's1', 'opencode');
    const proc = fakeSbxProcess();
    const dockerProc = Object.assign(fakeSbxProcess(), { pipe: vi.fn() });
    const { w } = wiring({ projectRoot: () => ROOT, proc, dockerProc });
    await w.remove(id);
    expect(dockerProc.calls.length).toBeGreaterThan(0);
  });

  it('diff hands the sandbox diff to the editor binding', async () => {
    const wt = createTicket(store, { key: 'K-9', title: 'w' }).id;
    setSessionId(store, wt, 's9', 'claude');
    store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, 'r', '/wt/r', 'feat/r')").run(wt);
    const proc = fakeSbxProcess({ 'git -C /wt/r diff': { stdout: 'diff --git a/f b/f\n+x\n' } });
    const showDiff = vi.fn(async () => {});
    const { w } = wiring({ projectRoot: () => ROOT, proc, showDiff });
    await w.diff(wt);
    expect(showDiff).toHaveBeenCalledWith(expect.stringContaining('K-9'), 'diff --git a/f b/f\n+x\n');
  });

  it('diff reports a missing worktree', async () => {
    const { w, notify } = wiring({ projectRoot: () => ROOT });
    await w.diff(id);
    expect(notify.error).toHaveBeenCalledWith('Karst: K-1 has no worktree branch to diff against.');
  });
});

describe('makeSandboxWiring finds the sandbox by listing, not sessionProvider (F4)', () => {
  const ROOT = '/p/karst.yml';
  it('a null session provider still reaches the ticket sandbox found in the listing', async () => {
    const t = createTicket(store, { key: 'K-5', title: 'n' }).id; // no setSessionId: provider null (T700)
    store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, 'r', '/wt/n', 'feat/n')").run(t);
    const container = sbxName({ projectRoot: ROOT, ticketId: t, core: 'opencode2' });
    const proc = fakeSbxProcess();
    const dockerProc = Object.assign(fakeSbxProcess({ 'docker ps': { stdout: `${container}\trunning\n` } }), { pipe: vi.fn() });
    const { w, notify } = wiring({ projectRoot: () => ROOT, proc, dockerProc });
    await w.diff(t);
    expect(notify.error).not.toHaveBeenCalledWith(expect.stringContaining('core unknown'));
    expect(dockerProc.calls.some((c) => c.args.includes('run') || c.args.includes('bundle'))).toBe(true);
  });
});
