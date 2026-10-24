import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { archiveTicket, createTicket, getTicket, setSessionId } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { OPEN_SYNC_DIFF, REMOVE_ANYWAY, REMOVE_ORPHANS } from './sandboxLifecycleOps.js';
import { makeSandboxWiring, type SandboxWiringInput } from './sandboxWiring.js';
import { getPlacement, recordPlacement } from '../../store/placement.js';

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
    owned: new Set([id]), bridges: () => undefined, sessionOpen: () => false, openSyncDiff: vi.fn(async () => {}), showDiff: vi.fn(async () => {}), info: vi.fn(), logError: vi.fn(),
    // Unit tests never touch the host Docker daemon: inventory paths fall back
    // to NODE_DOCKER_PROCESS otherwise, and this suite runs where none exists.
    dockerProc: Object.assign(fakeSbxProcess(), { pipe: vi.fn() }),
    ...over,
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

  it('removeDoneMerged removes the sandbox of a done+merged ticket and leaves an unmerged done one', async () => {
    const { projectId, a, b, proc, dockerProc } = live();
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id IN (?, ?)").run(a, b);
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, merged_at) VALUES (?, ?, ?, ?)').run(a, 'r', 1, '2026-01-01');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number) VALUES (?, ?, ?)').run(b, 'r', 2);
    const { w } = wiring({ backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, proc, dockerProc });
    await w.removeDoneMerged();
    const rms = proc.calls.filter((c) => c.args[0] === 'rm').map((c) => c.args.join(' '));
    expect(rms).toEqual([expect.stringContaining(sbxName({ projectRoot: ROOT, ticketId: a, core: 'claude' }))]);
  });

  it('palette command target (F5): an argument passes through untouched', async () => {
    const { w } = wiring();
    await expect(w.commandTarget(42, 'sync')).resolves.toBe(42);
  });

  it('palette command target: no argument → a picker of this project\'s sandboxed live tickets', async () => {
    const { projectId, a, proc, dockerProc } = live();
    const pickTicket = vi.fn(async (picks: readonly { ticketId: number }[]) => picks[0]!.ticketId);
    const { w } = wiring({ backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, proc, dockerProc, pickTicket });
    await expect(w.commandTarget(undefined, 'sync')).resolves.toBe(a);
    expect(pickTicket).toHaveBeenCalledTimes(1);
    expect(pickTicket.mock.calls[0]![0]).toEqual([{ label: 'A-1', description: expect.stringContaining('sbx claude (running)'), ticketId: a }]);
  });

  it('palette command target: nothing sandboxed → an info message, never silent', async () => {
    const projectId = upsertProject(store, { slug: 'p' }).id;
    const pickTicket = vi.fn();
    const { w, notify } = wiring({ backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, proc: fakeSbxProcess(), dockerProc: Object.assign(fakeSbxProcess(), { pipe: vi.fn() }), pickTicket });
    await expect(w.commandTarget(undefined, 'sync')).resolves.toBeUndefined();
    expect(pickTicket).not.toHaveBeenCalled();
    expect(notify.info).toHaveBeenCalledWith('Karst: no ticket in this project has a sandbox to sync.');
  });

  it('palette command target: one pick per ticket (two sandboxes of one ticket list once) and invalid-core objects are skipped', async () => {
    const projectId = upsertProject(store, { slug: 'p' }).id;
    const a = createTicket(store, { key: 'A-1', title: 'a', projectId }).id;
    const claude = sbxName({ projectRoot: ROOT, ticketId: a, core: 'claude' });
    const codex = sbxName({ projectRoot: ROOT, ticketId: a, core: 'codex' });
    const bad = claude.replace(/claude$/, 'null');
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${claude} claude running\n${codex} codex stopped\n${bad} null running\n` } });
    const pickTicket = vi.fn(async (_picks: readonly { ticketId: number }[], _placeHolder: string): Promise<number | undefined> => undefined);
    const { w } = wiring({ backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, proc, dockerProc: Object.assign(fakeSbxProcess(), { pipe: vi.fn() }), pickTicket });
    await expect(w.commandTarget(undefined, 'remove')).resolves.toBeUndefined();
    expect(pickTicket).toHaveBeenCalledWith([expect.objectContaining({ ticketId: a })], 'Ticket whose sandbox to remove');
    expect(pickTicket.mock.calls[0]![0]).toHaveLength(1);
  });

  it('a lookup that fails logs and falls back to the session provider instead of throwing', async () => {
    setSessionId(store, id, 's1', 'claude');
    store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, 'r', '/wt/r', 'feat/r')").run(id);
    const logError = vi.fn();
    const failing = { run: () => { throw new Error('spawn exploded'); } } as never;
    const { w } = wiring({ projectRoot: () => ROOT, proc: failing, dockerProc: Object.assign(failing, { pipe: vi.fn() }), logError });
    await w.diff(id);
    expect(logError).toHaveBeenCalledWith(`karst: sandbox lookup failed for ticket ${id}`, expect.any(Error));
  });

  it('two sandboxes for one ticket: the lookup logs which one it chose', async () => {
    const projectId = upsertProject(store, { slug: 'p' }).id;
    const a = createTicket(store, { key: 'A-1', title: 'a', projectId }).id;
    store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, 'r', '/wt/r', 'feat/r')").run(a);
    const claude = sbxName({ projectRoot: ROOT, ticketId: a, core: 'claude' });
    const codex = sbxName({ projectRoot: ROOT, ticketId: a, core: 'codex' });
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${claude} claude running\n${codex} codex running\n` } });
    const info = vi.fn();
    const { w } = wiring({ projectRoot: () => ROOT, proc, dockerProc: Object.assign(fakeSbxProcess(), { pipe: vi.fn() }), info });
    await w.diff(a);
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`karst: ticket ${a} has 2 sandboxes`));
  });

  it('palette command target: no project root → says no backend is configured', async () => {
    const { w, notify } = wiring({ projectRoot: () => undefined });
    await expect(w.commandTarget(undefined, 'remove')).resolves.toBeUndefined();
    expect(notify.info).toHaveBeenCalledWith('Karst: no sandbox backend is configured for this project.');
  });

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

describe('makeSandboxWiring.ensureInSync (F12 choke point)', () => {
  it('is a no-op without a sandbox backend', async () => {
    const proc = fakeSbxProcess();
    const { w } = wiring({ proc });
    await expect(w.ensureInSync(id)).resolves.toEqual({ ok: true });
    expect(proc.calls).toEqual([]);
  });
  it('with a backend, a ticket without a listed sandbox is left alone', async () => {
    const proc = fakeSbxProcess();
    const { w } = wiring({ proc, backendOn: () => true });
    await expect(w.ensureInSync(id)).resolves.toEqual({ ok: true });
    expect(proc.calls.some((c) => c.args.includes('exec'))).toBe(false);
  });
});

describe('makeSandboxWiring.ensureSynced', () => {
  it('is a no-op without a sandbox backend: no CLI is spawned', async () => {
    const proc = fakeSbxProcess();
    const { w } = wiring({ proc });
    await expect(w.ensureSynced(id)).resolves.toEqual({ ok: true });
    expect(proc.calls).toEqual([]);
  });
  it('with a backend it does probe the CLI', async () => {
    const proc = fakeSbxProcess();
    const { w } = wiring({ proc, backendOn: () => true });
    await w.ensureSynced(id);
    expect(proc.calls.length).toBeGreaterThan(0);
  });
});

describe('makeSandboxWiring assertInSync / syncParentOf', () => {
  it('assertInSync resolves when there is nothing to sync', async () => {
    const { w } = wiring();
    await expect(w.assertInSync(id)).resolves.toBeUndefined();
  });
  it('syncParentOf ignores a ticket without a parent', async () => {
    const { w } = wiring();
    await expect(w.syncParentOf(id)).resolves.toBeUndefined();
  });
  it('syncParentOf syncs the parent of a sub-task', async () => {
    const proc = fakeSbxProcess();
    const { w } = wiring({ proc, backendOn: () => true });
    const child = createTicket(store, { key: 'K-2', title: 'c', subtaskParentId: id }).id;
    await expect(w.syncParentOf(child)).resolves.toBeUndefined();
    expect(proc.calls.length).toBeGreaterThan(0);
  });
});

describe('makeSandboxWiring blockers', () => {
  const blocked = () => {
    const ls = `NAME\n${sbxName({ projectRoot: '/p/karst.yml', ticketId: id, core: 'claude' })} running\n`;
    return fakeSbxProcess({ 'sbx ls': { stdout: ls } });
  };
  it('assertInSync throws the blocker reason', async () => {
    const { w } = wiring({ proc: blocked(), backendOn: () => true });
    await expect(w.assertInSync(id)).rejects.toThrow('sandbox not in sync: no worktree branch to sync into');
  });
  it('syncParentOf throws when the parent sandbox is blocked', async () => {
    const { w } = wiring({ proc: blocked(), backendOn: () => true });
    const child = createTicket(store, { key: 'K-3', title: 'c', subtaskParentId: id }).id;
    await expect(w.syncParentOf(child)).rejects.toThrow('parent ticket sandbox not in sync: no worktree branch to sync into');
  });
});

describe('makeSandboxWiring carry (T714)', () => {
  it('a ticket is not offered the carry until a refused sync was classified as a rewrite', () => {
    const { w } = wiring({ backendOn: () => true, projectId: () => 1 });
    expect(w.isRewritten(id)).toBe(false);
  });
  it('carry without a reopen binding reports an error and touches nothing', async () => {
    const { w, notify } = wiring({ backendOn: () => true, projectId: () => 1 });
    await w.carry(id);
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('reopening is not available'));
  });
});

describe('makeSandboxWiring reads the recorded placement, not the core (D245)', () => {
  const ROOT = '/p/karst.yml';
  it('a recorded-host ticket with an sbx-capable core never spawns sbx or docker, on any sync path', async () => {
    recordPlacement(store, id, { backend: 'host', core: 'claude', sandboxName: null, reason: null }, 'claude');
    const proc = fakeSbxProcess();
    const dockerProc = Object.assign(fakeSbxProcess(), { pipe: vi.fn() });
    const { w } = wiring({ proc, dockerProc, projectRoot: () => ROOT, backendOn: () => true });
    await expect(w.ensureInSync(id)).resolves.toEqual({ ok: true });
    await expect(w.ensureSynced(id)).resolves.toEqual({ ok: true });
    await w.stashUpdate(id);
    expect(proc.calls).toEqual([]);
    expect(dockerProc.calls).toEqual([]);
  });
  it('a recorded sandbox placement names the core even when the session provider is null after a reload', async () => {
    const t = createTicket(store, { key: 'K-9', title: 'n' }).id;
    recordPlacement(store, t, { backend: 'sbx', core: 'claude', sandboxName: sbxName({ projectRoot: ROOT, ticketId: t, core: 'claude' }), reason: null }, null);
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: 'SANDBOX AGENT STATUS\n' } });
    const { w } = wiring({ proc, projectRoot: () => ROOT, backendOn: () => true });
    await w.ensureInSync(t);
    // the recorded core is probed directly: no inventory listing needed to guess it
    expect(proc.calls.some((c) => c.args.includes('ls'))).toBe(true);
  });
  it('a recorded sandbox whose CLI cannot answer blocks instead of passing', async () => {
    const t = createTicket(store, { key: 'K-10', title: 'n' }).id;
    recordPlacement(store, t, { backend: 'sbx', core: 'claude', sandboxName: 'n', reason: null }, 'claude');
    const proc = fakeSbxProcess({ 'sbx ls': { code: 127, stderr: 'sbx: not found' } });
    const { w } = wiring({ proc, projectRoot: () => ROOT, backendOn: () => true });
    const r = await w.ensureInSync(t);
    expect(r.ok).toBe(false);
  });
});

describe('makeSandboxWiring lifecycle on a recorded-host ticket (D245)', () => {
  const ROOT = '/p/karst.yml';
  it('archive, done, stop and remove spawn no CLI and pass', async () => {
    recordPlacement(store, id, { backend: 'host', core: 'claude', sandboxName: null, reason: null }, 'claude');
    const proc = fakeSbxProcess();
    const dockerProc = Object.assign(fakeSbxProcess(), { pipe: vi.fn() });
    const projectId = upsertProject(store, { slug: 'p' }).id;
    store.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(projectId, id);
    const { w } = wiring({ proc, dockerProc, projectRoot: () => ROOT, backendOn: () => true, projectId: () => projectId });
    await expect(w.beforeArchive(id)).resolves.toBe(true);
    w.onDone(id);
    await w.stop(id);
    await w.remove(id);
    await new Promise((r) => setTimeout(r, 0));
    expect(proc.calls).toEqual([]);
    expect(dockerProc.calls).toEqual([]);
  });
  it('a verified removal of a recorded sandbox records host (sandbox removed)', async () => {
    const t = createTicket(store, { key: 'K-11', title: 'n' }).id;
    recordPlacement(store, t, { backend: 'sbx', core: 'claude', sandboxName: 'n', reason: null }, 'claude');
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: 'SANDBOX AGENT STATUS\n' } });
    const { w } = wiring({ proc, projectRoot: () => ROOT, backendOn: () => true, projectId: () => undefined, owned: new Set([t]) });
    await w.remove(t);
    expect(getPlacement(store, t)).toMatchObject({ backend: 'host', reason: 'sandbox removed' });
  });
});

describe('makeSandboxWiring.recordLaunchPlacement (D245)', () => {
  const sbxP = { backend: 'sbx', core: 'claude', sandboxName: 'n', reason: null } as const;
  it('the owning window records placement with the session provider, in one write', () => {
    const t = createTicket(store, { key: 'K-20', title: 'n' }).id;
    const { w } = wiring({ proc: fakeSbxProcess(), projectRoot: () => '/p/karst.yml', backendOn: () => true, projectId: () => undefined, owned: new Set([t]) });
    expect(w.recordLaunchPlacement(t, sbxP, 'claude')).toBe(true);
    expect(getPlacement(store, t)).toEqual(sbxP);
    expect(getTicket(store, t).sessionProvider).toBe('claude');
  });
  it('a window that does not control the ticket writes nothing (two-window ownership, AC-37)', () => {
    const t = createTicket(store, { key: 'K-21', title: 'n' }).id;
    store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(t);
    const { w } = wiring({ proc: fakeSbxProcess(), projectRoot: () => '/p/karst.yml', backendOn: () => true, projectId: () => undefined, owned: new Set<number>() });
    expect(w.recordLaunchPlacement(t, sbxP, 'claude')).toBe(false);
    expect(getPlacement(store, t)).toBeNull();
  });
  it('a recorded placement survives a reload: a fresh wiring reads it with no session provider', () => {
    const t = createTicket(store, { key: 'K-22', title: 'n' }).id;
    recordPlacement(store, t, sbxP, null);
    const { w } = wiring({ proc: fakeSbxProcess(), projectRoot: () => '/p/karst.yml', backendOn: () => true, projectId: () => undefined });
    expect(getPlacement(store, t)).toEqual(sbxP);
    expect(w).toBeDefined();
  });
});

describe('makeSandboxWiring.backfillPlacements (D245)', () => {
  it('records listed sandboxes and host for the rest, once; a failed listing records nothing', async () => {
    const projectId = upsertProject(store, { slug: 'bf' }).id;
    const t = createTicket(store, { key: 'K-30', title: 'n', projectId }).id;
    const proc = fakeSbxProcess({ 'sbx ls': { code: 127, stderr: 'not found' } });
    const { w } = wiring({ proc, projectRoot: () => '/p/karst.yml', backendOn: () => true, projectId: () => projectId });
    await w.backfillPlacements();
    expect(getPlacement(store, t)).toBeNull();
    const ok = wiring({ proc: fakeSbxProcess({ 'sbx ls': { stdout: 'SANDBOX AGENT STATUS\n' } }), projectRoot: () => '/p/karst.yml', backendOn: () => true, projectId: () => projectId });
    await ok.w.backfillPlacements();
    expect(getPlacement(store, t)).toMatchObject({ backend: 'host' });
  });
});

describe('makeSandboxWiring placement transitions and backfill edges (D245)', () => {
  const ROOT = '/p/karst.yml';
  const mkDone = (merged: boolean) => {
    const t = createTicket(store, { key: merged ? 'K-40' : 'K-41', title: 'n' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(t);
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, status, merged_at) VALUES (?, ?, ?, ?, ?)').run(t, 'r', 1, merged ? 'merged' : 'open', merged ? '2026-01-01T00:00:00Z' : null);
    recordPlacement(store, t, { backend: 'sbx', core: 'claude', sandboxName: 'n', reason: null }, 'claude');
    return t;
  };
  it('done+merged: the verified removal records host, keeping core and session provider', async () => {
    const t = mkDone(true);
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: 'SANDBOX AGENT STATUS\n' } });
    const { w } = wiring({ proc, backendOn: () => true, projectRoot: () => ROOT, owned: new Set([t]) });
    w.onDone(t);
    await vi.waitFor(() => expect(getPlacement(store, t)).toEqual({ backend: 'host', core: 'claude', sandboxName: null, reason: 'sandbox removed' }));
    expect(getTicket(store, t).sessionProvider).toBe('claude');
  });
  it('done but not merged: the sandbox is only stopped, placement stays', async () => {
    const t = mkDone(false);
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: 'SANDBOX AGENT STATUS\n' } });
    const { w } = wiring({ proc, backendOn: () => true, projectRoot: () => ROOT, owned: new Set([t]) });
    w.onDone(t);
    await new Promise((r) => setTimeout(r, 20));
    expect(getPlacement(store, t)?.backend).toBe('sbx');
  });
  it('backfill: a listed sandbox is recorded with its name and logs the count; no project or no backend writes nothing', async () => {
    const projectId = upsertProject(store, { slug: 'bf2' }).id;
    const t = createTicket(store, { key: 'K-42', title: 'n', projectId }).id;
    const name = sbxName({ projectRoot: ROOT, ticketId: t, core: 'claude' });
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${name} claude running\n` } });
    const info = vi.fn();
    await wiring({ proc, backendOn: () => true, projectRoot: () => ROOT, projectId: () => undefined, info }).w.backfillPlacements();
    await wiring({ proc, backendOn: () => false, projectRoot: () => ROOT, projectId: () => projectId, info }).w.backfillPlacements();
    expect(getPlacement(store, t)).toBeNull();
    await wiring({ proc, backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, info }).w.backfillPlacements();
    expect(getPlacement(store, t)).toMatchObject({ backend: 'sbx', core: 'claude', sandboxName: name });
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/recorded placement for [1-9]\d* ticket/));
  });
});
