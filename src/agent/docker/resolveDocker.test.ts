import { describe, expect, it, vi } from 'vitest';
import { fakeDockerProcess } from './fakeDockerProcess.js';
import { DOCKER_ASSETS_DIR, linuxUser, resolveDocker } from './resolveDocker.js';

const WT = { hostWorktreePath: '/w/t7', branch: 'feat/x' };
const pass = vi.fn().mockResolvedValue({ ok: true });
const base = { projectRoot: '/p', ticketId: 7, worktree: WT };
const deps = (extra = {}) => ({ proc: fakeDockerProcess(), preflight: pass, prepare: pass, platform: 'darwin' as const, hostAuthFile: () => Promise.resolve(undefined), ...extra });

describe('resolveDocker', () => {
  it.each(['opencode', 'opencode2'])('prepares and returns an enforcing docker runner for %s', async (core) => {
    const out = await resolveDocker({ ...base, core, deps: deps() });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runner.kind).toBe('docker');
    expect(out.runner.enforcesSandbox).toBe(true);
    expect(out.names.container).toMatch(new RegExp(`^karst-[0-9a-f]{8}-7-${core}$`));
  });

  it.each(['claude', 'codex', 'antigravity'])('refuses %s (agy deferred, claude/codex are sbx)', async (core) => {
    const preflight = vi.fn();
    await expect(resolveDocker({ ...base, core, deps: deps({ preflight }) })).resolves.toEqual({ ok: false, reason: `${core}: docker backend unsupported` });
    expect(preflight).not.toHaveBeenCalled();
  });

  it('needs a worktree branch to clone', async () => {
    await expect(resolveDocker({ ...base, worktree: undefined, core: 'opencode', deps: deps() })).resolves.toEqual({ ok: false, reason: 'docker: ticket has no worktree branch to clone' });
    await expect(resolveDocker({ ...base, worktree: { hostWorktreePath: '/w', branch: '' }, core: 'opencode', deps: deps() })).resolves.toMatchObject({ ok: false });
  });

  it('returns the preflight reason and does not prepare', async () => {
    const prepare = vi.fn();
    const preflight = vi.fn().mockResolvedValue({ ok: false, reason: 'docker daemon not reachable: x' });
    await expect(resolveDocker({ ...base, core: 'opencode', deps: deps({ preflight, prepare }) })).resolves.toEqual({ ok: false, reason: 'docker daemon not reachable: x' });
    expect(prepare).not.toHaveBeenCalled();
    expect(preflight.mock.calls[0]![1]).toBe(DOCKER_ASSETS_DIR);
  });

  it('returns the prepare reason', async () => {
    const prepare = vi.fn().mockResolvedValue({ ok: false, reason: 'proxy sidecar failed to start: y' });
    await expect(resolveDocker({ ...base, core: 'opencode', deps: deps({ prepare }) })).resolves.toEqual({ ok: false, reason: 'proxy sidecar failed to start: y' });
  });

  it('hands prepare the linux user, proxy script, ticket and (v2 only) the host credential source', async () => {
    const prepare = vi.fn().mockResolvedValue({ ok: true });
    const debug = vi.fn();
    const host = { command: '/abs/opencode2', env: { XDG_DATA_HOME: '/k/data' } };
    await resolveDocker({ ...base, core: 'opencode2', deps: deps({ prepare, platform: 'linux', uid: 1001, gid: 1002, assetsDir: '/ext/sb', opencode2Host: () => host, debug }) });
    expect(prepare.mock.calls[0]![0]).toMatchObject({
      core: 'opencode2', user: { uid: 1001, gid: 1002 }, ticket: WT, proxyScript: '/ext/sb/allowlist-proxy.mjs', opencode2Host: host, debug,
    });
    await resolveDocker({ ...base, core: 'opencode', deps: deps({ prepare }) });
    expect(prepare.mock.calls[1]![0]).not.toHaveProperty('opencode2Host');
    expect(prepare.mock.calls[1]![0].user).toBeUndefined();
  });

  it('mounts the v1 auth file when the host has one', async () => {
    const out = await resolveDocker({ ...base, core: 'opencode', deps: deps({ hostAuthFile: () => Promise.resolve('/h/auth.json') }) });
    if (!out.ok) throw new Error(out.reason);
    const placed = out.runner.placeInteractive({ ticketId: 7, hostWorktreePath: '/w/t7', command: 'opencode', args: [], env: {} });
    expect(placed.shellArgs.join(' ')).toContain('source=/h/auth.json,target=/home/node/.local/share/opencode/auth.json,readonly');
  });

  it('never throws: an unsafe name becomes the reason', async () => {
    await expect(resolveDocker({ ...base, ticketId: 0, core: 'opencode', deps: deps() })).resolves.toEqual({ ok: false, reason: 'sbx name: invalid ticket id 0' });
  });

  it('stringifies a non-Error throw', async () => {
    const preflight = vi.fn().mockRejectedValue('boom');
    await expect(resolveDocker({ ...base, core: 'opencode', deps: deps({ preflight }) })).resolves.toEqual({ ok: false, reason: 'boom' });
  });
});

describe('linuxUser', () => {
  it('is set only on linux with both ids', () => {
    expect(linuxUser('linux', 1001, 1002)).toEqual({ uid: 1001, gid: 1002 });
    expect(linuxUser('darwin', 1001, 1002)).toBeUndefined();
    expect(linuxUser('win32', 1, 1)).toBeUndefined();
    expect(linuxUser('linux', undefined, 1)).toBeUndefined();
    expect(linuxUser('linux', 1, undefined)).toBeUndefined();
  });
});

describe('resolveDocker: baseline host ports (arch:AC-32)', () => {
  it('passes declared baseline ports to prepare, and none when empty', async () => {
    const prepare = vi.fn().mockResolvedValue({ ok: true });
    await resolveDocker({ ...base, core: 'opencode', deps: deps({ prepare, hostPorts: [5432] }) });
    expect(prepare.mock.calls[0]![0].hostPorts).toEqual([5432]);
    await resolveDocker({ ...base, core: 'opencode', deps: deps({ prepare, hostPorts: [] }) });
    expect(prepare.mock.calls[1]![0]).not.toHaveProperty('hostPorts');
  });
});
