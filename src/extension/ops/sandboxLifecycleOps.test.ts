import { describe, expect, it, vi } from 'vitest';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import type { ProjectSandbox, SandboxInventory } from '../../agent/sandboxInventory.js';
import {
  backendKindOf, cleanupOrphansOp, idleSandboxes, reconcileSandboxes, removeSandboxGuarded, stopSandboxOp, switchProviderOp,
  CANCEL, OPEN_SYNC_DIFF, REMOVE_ANYWAY, REMOVE_ORPHANS, type SandboxLifecycleDeps,
} from './sandboxLifecycleOps.js';

const ROOT = '/p/karst.yml';
const name = (id: number, core = 'claude'): string => sbxName({ projectRoot: ROOT, ticketId: id, core });
const box = (id: number, core = 'claude', state: 'running' | 'stopped' = 'running'): ProjectSandbox =>
  ({ runner: core.startsWith('opencode') ? 'docker' : 'sbx', name: name(id, core), ticketId: id, core, state });
const target = { ticketId: 7, ticketLabel: 'T-7', core: 'claude', worktree: { path: '/wt', branch: 'feat/x' } };

type Answers = Record<string, { code?: number; stdout?: string; stderr?: string }>;

/** `sbx ls` / `docker ps` answers that list exactly these sandboxes. */
function listing(boxes: readonly ProjectSandbox[]): Answers {
  const sbx = boxes.filter((b) => b.runner === 'sbx').map((b) => `${b.name} ${b.core} ${b.state}`);
  const docker = boxes.filter((b) => b.runner === 'docker').map((b) => `${b.name}\t${b.state === 'running' ? 'running' : 'exited'}`);
  return { 'sbx ls': { stdout: ['SANDBOX AGENT STATUS', ...sbx, ''].join('\n') }, 'docker ps': { stdout: docker.join('\n') } };
}

function deps(over: Partial<SandboxLifecycleDeps> & { inv?: readonly ProjectSandbox[]; answers?: Answers } = {}) {
  const { inv, answers, ...rest } = over;
  const all = { ...listing(inv ?? [box(7), box(8)]), ...answers };
  const proc = fakeSbxProcess(all);
  const dockerProc = Object.assign(fakeSbxProcess(all), { pipe: vi.fn() });
  const notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) };
  const d = {
    notify, projectRoot: ROOT, proc, dockerProc,
    choose: vi.fn(async (): Promise<string | undefined> => undefined),
    owns: (): boolean => true,
    bridges: { dispose: vi.fn(async () => {}) },
    openSyncDiff: vi.fn(async () => {}),
    ...rest,
  };
  const lines = (): string[] => [...proc.calls, ...dockerProc.calls].map((c) => [c.command, ...c.args].join(' '));
  const acted = (): string[] => lines().filter((l) => !l.startsWith('sbx ls') && !l.startsWith('docker ps'));
  return { d, proc, notify, lines, acted };
}

describe('backendKindOf', () => {
  it('maps cores to runners', () => {
    expect(backendKindOf('claude')).toBe('sbx');
    expect(backendKindOf('codex')).toBe('sbx');
    expect(backendKindOf('opencode2')).toBe('docker');
    expect(backendKindOf('agy')).toBe('host');
    expect(backendKindOf(null)).toBe('host');
  });
});

describe('removeSandboxGuarded', () => {
  it('sync ok → disposes exactly this sandbox, bystander untouched', async () => {
    const { d, lines } = deps();
    await expect(removeSandboxGuarded(d, target)).resolves.toBe(true);
    expect(lines()).toContain(`sbx rm --force ${name(7)}`);
    expect(lines().some((l) => l.includes(name(8)))).toBe(false);
    expect(d.bridges.dispose).toHaveBeenCalledWith(7);
    expect(d.choose).not.toHaveBeenCalled();
  });

  it('unsynced + dismissed → blocked, nothing removed', async () => {
    const { d, acted } = deps({ answers: { 'git -C /wt merge-base': { code: 1 } } });
    await expect(removeSandboxGuarded(d, target)).resolves.toBe(false);
    expect(d.choose).toHaveBeenCalledWith(expect.stringContaining('T-7'), [OPEN_SYNC_DIFF, REMOVE_ANYWAY, CANCEL]);
    expect(acted().some((l) => l.includes(' rm '))).toBe(false);
  });

  it('unsynced + remove anyway → removed', async () => {
    const { d, lines } = deps({ answers: { 'git -C /wt merge-base': { code: 1 } }, choose: vi.fn(async () => REMOVE_ANYWAY) });
    await expect(removeSandboxGuarded(d, target)).resolves.toBe(true);
    expect(lines()).toContain(`sbx rm --force ${name(7)}`);
  });

  it('unsynced + open diff → diff opened, blocked', async () => {
    const openSyncDiff = vi.fn(async () => {});
    const { d } = deps({ answers: { 'git -C /wt merge-base': { code: 1 } }, choose: vi.fn(async () => OPEN_SYNC_DIFF), openSyncDiff });
    await expect(removeSandboxGuarded(d, target)).resolves.toBe(false);
    expect(openSyncDiff).toHaveBeenCalledWith(target);
  });

  it('no sandbox listed → no-op', async () => {
    const { d, acted } = deps({ inv: [box(8)] });
    await expect(removeSandboxGuarded(d, target)).resolves.toBe(true);
    expect(acted()).toEqual([]);
  });

  it('host core → no-op; non-owner window → refused', async () => {
    const { d, proc } = deps();
    await expect(removeSandboxGuarded(d, { ...target, core: 'agy' })).resolves.toBe(true);
    const other = deps({ owns: () => false });
    await expect(removeSandboxGuarded(other.d, target)).resolves.toBe(false);
    expect([...proc.calls, ...other.proc.calls]).toEqual([]);
  });

  it('dispose failure is reported, not thrown', async () => {
    const { d, notify } = deps({ bridges: { dispose: vi.fn(async () => { throw new Error('busy'); }) } });
    await expect(removeSandboxGuarded(d, target)).resolves.toBe(false);
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('busy'));
  });
});

describe('stopSandboxOp', () => {
  it('owner stops its own sandbox only', async () => {
    const { d, lines } = deps();
    await expect(stopSandboxOp(d, target)).resolves.toBe(true);
    expect(lines().at(-1)).toBe(`sbx stop ${name(7)}`);
  });
  it('syncs before it stops, and a good sync retries the ticket\'s pending marker (arch:AC-37)', async () => {
    const retry = vi.fn(async () => {});
    const { d, lines } = deps({ bridges: { dispose: async () => {}, retryPending: retry } });
    await stopSandboxOp(d, target);
    const all = lines();
    expect(all.findIndex((l) => l.includes('merge'))).toBeGreaterThanOrEqual(0);
    expect(all.findIndex((l) => l.includes('merge'))).toBeLessThan(all.indexOf(`sbx stop ${name(7)}`));
    expect(retry).toHaveBeenCalledWith(7);
  });
  it('a failed sync warns but still stops the sandbox', async () => {
    const { d, lines, notify } = deps({ answers: { 'git -C /wt merge-base': { code: 1 } } });
    await expect(stopSandboxOp(d, target)).resolves.toBe(true);
    expect(notify.warn).toHaveBeenCalledWith(expect.stringContaining('not synced before stop'));
    expect(lines().at(-1)).toBe(`sbx stop ${name(7)}`);
  });
  it('non-owner and host core do nothing', async () => {
    const { d, proc } = deps({ owns: () => false });
    await expect(stopSandboxOp(d, target)).resolves.toBe(false);
    const host = deps();
    await expect(stopSandboxOp(host.d, { ...target, core: 'agy' })).resolves.toBe(false);
    expect([...proc.calls, ...host.proc.calls]).toEqual([]);
  });
});

describe('switchProviderOp', () => {
  it('kind change → sync + dispose old, session dropped', async () => {
    const clearSession = vi.fn();
    const { d, lines } = deps();
    await expect(switchProviderOp({ ...d, clearSession }, target, 'opencode')).resolves.toBe(true);
    expect(lines()).toContain(`sbx rm --force ${name(7)}`);
    expect(clearSession).toHaveBeenCalledWith(7);
  });
  it('same backend kind (claude → codex) still removes the old core sandbox', async () => {
    const clearSession = vi.fn();
    const { d, lines } = deps();
    await expect(switchProviderOp({ ...d, clearSession }, target, 'codex')).resolves.toBe(true);
    expect(lines()).toContain(`sbx rm --force ${name(7)}`);
    expect(clearSession).toHaveBeenCalledWith(7);
  });
  it('blocked remove keeps the session id', async () => {
    const clearSession = vi.fn();
    const { d } = deps({ answers: { 'git -C /wt merge-base': { code: 1 } } });
    await expect(switchProviderOp({ ...d, clearSession }, target, 'opencode')).resolves.toBe(false);
    expect(clearSession).not.toHaveBeenCalled();
  });
  it('unchanged core → nothing', async () => {
    const clearSession = vi.fn();
    const { d } = deps();
    await expect(switchProviderOp({ ...d, clearSession }, target, 'claude')).resolves.toBe(true);
    expect(clearSession).not.toHaveBeenCalled();
  });
});

describe('reconcileSandboxes', () => {
  const live = [
    { id: 7, sessionId: 's7', sessionProvider: 'claude' },
    { id: 8, sessionId: 's8', sessionProvider: 'codex' },
    { id: 9, sessionId: 's9', sessionProvider: 'opencode' },
    { id: 10, sessionId: 's10', sessionProvider: 'claude' },
    { id: 11, sessionId: 's11', sessionProvider: 'agy' },
  ];
  it('adopts running, leaves stopped, refreshes missing, reports orphans', () => {
    const clear = vi.fn();
    const inv = { sandboxes: [box(7), box(8, 'codex', 'stopped'), box(42)], errors: [] };
    const r = reconcileSandboxes(inv, live, (id) => id !== 10, clear);
    expect(r).toEqual({ running: [7], stopped: [8], missing: [9], orphans: [box(42)] });
    expect(clear.mock.calls).toEqual([[9]]);
  });
  it('a failed listing proves nothing missing', () => {
    const clear = vi.fn();
    const r = reconcileSandboxes({ sandboxes: [], errors: ['docker ps failed: down'] }, live, () => true, clear);
    expect(r.missing).toEqual([7, 8, 10]);
    expect(clear).not.toHaveBeenCalledWith(9);
  });
  it('no session id → nothing to drop', () => {
    const clear = vi.fn();
    reconcileSandboxes({ sandboxes: [], errors: [] }, [{ id: 7, sessionId: null, sessionProvider: 'claude' }], () => true, clear);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('cleanupOrphansOp', () => {
  it('removes orphans only after confirmation', async () => {
    const { d, lines } = deps({ choose: vi.fn(async () => REMOVE_ORPHANS) });
    await expect(cleanupOrphansOp(d, new Set([7]))).resolves.toBe(1);
    expect(lines()).toContain(`sbx rm --force ${name(8)}`);
    expect(lines().some((l) => l.includes(name(7)))).toBe(false);
  });
  it('cancel removes nothing; none → info', async () => {
    const { d, acted } = deps();
    await expect(cleanupOrphansOp(d, new Set([7]))).resolves.toBe(0);
    expect(acted()).toEqual([]);
    const none = deps();
    await expect(cleanupOrphansOp(none.d, new Set([7, 8]))).resolves.toBe(0);
    expect(none.notify.info).toHaveBeenCalledWith('Karst: no orphan sandboxes.');
  });
});

describe('lifecycle edge cases', () => {
  it('non-owner is told why', async () => {
    const { d, notify } = deps({ owns: () => false });
    await removeSandboxGuarded(d, target);
    expect(notify.warn).toHaveBeenCalledWith('Karst: T-7 is owned by another window; its sandbox was left alone.');
  });

  it('a failed listing does not prove absence: sync is still attempted', async () => {
    const { d, lines } = deps({ inv: [], answers: { 'sbx ls': { code: 1, stderr: 'down' } } });
    await expect(removeSandboxGuarded(d, target)).resolves.toBe(true);
    expect(lines()).toContain('git -C /wt merge --ff-only sandbox-' + name(7) + '/feat/x');
  });

  it('a docker sandbox is matched by core too', async () => {
    const { d, acted } = deps({ inv: [box(7, 'opencode')] });
    await expect(removeSandboxGuarded(d, target)).resolves.toBe(true);
    expect(acted()).toEqual([]);
  });

  it('no worktree branch → asks, remove anyway disposes against the project dir', async () => {
    const choose = vi.fn(async (_m: string, _c: readonly string[]): Promise<string | undefined> => REMOVE_ANYWAY);
    const { d, lines, notify } = deps({ choose });
    await expect(removeSandboxGuarded(d, { ...target, worktree: undefined })).resolves.toBe(true);
    expect(choose.mock.calls[0]![0]).toBe(
      'Karst: the sandbox of T-7 has commits that could not be synced (no worktree branch to sync into). Removing it loses them.');
    expect(lines()).toContain(`git -C /p remote remove sandbox-${name(7)}`);
    expect(lines().some((l) => l.includes('fetch'))).toBe(false);
    expect(notify.info).toHaveBeenCalledWith('Karst: T-7 sandbox removed.');
  });

  it('kept sandbox is reported; works before the bridge registry exists', async () => {
    const kept = deps({ answers: { 'git -C /wt merge-base': { code: 1 } } });
    await removeSandboxGuarded(kept.d, target);
    expect(kept.notify.warn).toHaveBeenCalledWith('Karst: kept the sandbox of T-7.');
    const bare = deps();
    const { bridges: _b, ...noBridges } = bare.d;
    await expect(removeSandboxGuarded(noBridges, target)).resolves.toBe(true);
  });

  it('dispose error text names ticket and cause', async () => {
    const { d, notify } = deps({ bridges: { dispose: vi.fn(async () => { throw new Error('busy'); }) } });
    await removeSandboxGuarded(d, target);
    expect(notify.error).toHaveBeenCalledWith('Karst: removing the sandbox for T-7 failed: busy');
  });

  it('stop failure warns; host core stop is silent', async () => {
    const { d, notify } = deps();
    const failing = { ...d, proc: { run: vi.fn(async () => { throw new Error('gone'); }) } };
    await expect(stopSandboxOp(failing, target)).resolves.toBe(false);
    expect(notify.warn).toHaveBeenCalledWith('Karst: stopping the sandbox for T-7 failed: gone');
    const host = deps();
    await stopSandboxOp(host.d, { ...target, core: 'agy' });
    expect(host.notify.warn).not.toHaveBeenCalled();
  });

  it('reconcile: an sbx listing error does not shield docker tickets', () => {
    const clear = vi.fn();
    const live = [{ id: 7, sessionId: 's', sessionProvider: 'claude' }, { id: 9, sessionId: 's', sessionProvider: 'opencode' }];
    const r = reconcileSandboxes({ sandboxes: [], errors: ['sbx ls failed: x'] }, live, () => true, clear);
    expect(r.missing).toEqual([9]);
  });

  it('reconcile: a sandbox of another core is not this ticket\'s', () => {
    const r = reconcileSandboxes({ sandboxes: [box(7, 'codex')], errors: [] },
      [{ id: 7, sessionId: 's', sessionProvider: 'claude' }], () => true, vi.fn());
    expect(r).toEqual({ running: [], stopped: [], missing: [7], orphans: [] });
  });

  it('cleanup: confirm text lists names, dispose errors warn, count reported', async () => {
    const choose = vi.fn(async () => REMOVE_ORPHANS);
    const { d, notify } = deps({ choose, inv: [box(8), box(9, 'opencode')] });
    const failingDocker = Object.assign(fakeSbxProcess(listing([box(8), box(9, 'opencode')])), { pipe: vi.fn() });
    const run = failingDocker.run;
    failingDocker.run = (c, a, o) => (a[0] === 'rm' ? Promise.reject(new Error('locked')) : run(c, a, o));
    await expect(cleanupOrphansOp({ ...d, dockerProc: failingDocker }, new Set())).resolves.toBe(1);
    expect(choose).toHaveBeenCalledWith(`Karst: remove 2 orphan sandbox(es) of this project? ${name(8)}, ${name(9, 'opencode')}`, [REMOVE_ORPHANS, CANCEL]);
    expect(notify.warn).toHaveBeenCalledWith(`Karst: removing orphan sandbox ${name(9, 'opencode')} failed: locked`);
    expect(notify.info).toHaveBeenCalledWith('Karst: removed 1 orphan sandbox(es).');
  });
});

describe('idleSandboxes', () => {
  const H = 60 * 60_000;
  const inv = { sandboxes: [box(1), box(2), box(3), box(4, 'claude', 'stopped'), box(5)], errors: [] };
  const tickets = [
    { id: 1, updatedAtMs: 0, sessionOpen: false },            // idle → stop
    { id: 2, updatedAtMs: 0, sessionOpen: true },             // session open → keep
    { id: 3, updatedAtMs: 3 * H - 1, sessionOpen: false },    // recent → keep
    { id: 4, updatedAtMs: 0, sessionOpen: false },            // already stopped
    { id: 5, updatedAtMs: 0, sessionOpen: false },            // other window
  ];
  it('picks only running, owned, session-less tickets idle past the threshold', () => {
    expect(idleSandboxes(inv, tickets, (id) => id !== 5, 3 * H, 2 * H).map((b) => b.ticketId)).toEqual([1]);
  });
  it('exactly at the threshold is not idle; unknown ticket is never idle', () => {
    expect(idleSandboxes(inv, [{ id: 1, updatedAtMs: H, sessionOpen: false }], () => true, 3 * H, 2 * H)).toEqual([]);
    expect(idleSandboxes({ sandboxes: [box(9)], errors: [] }, tickets, () => true, 3 * H, 2 * H)).toEqual([]);
  });
});
