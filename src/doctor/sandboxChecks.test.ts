import { describe, expect, it } from 'vitest';
import {
  SANDBOX_DISK_WARN_BYTES,
  STALE_REMOTE_WORKSPACE_DAYS,
  checkForeignRemoteWorkspaces,
  checkRemoteDiskFacts,
  checkSandboxBackends,
  checkSandboxSetupDeclared,
  checkSshRemotes,
  checkStaleRemoteWorkspaces,
  parseDockerSize,
  type SetupRepoFact,
  type SshPreflightFacts,
} from './sandboxChecks.js';
import { formatDoctorBytes } from './formatBytes.js';

const OK = { ok: true } as const;
const base = { selected: ['sbx'], sbx: OK, docker: OK, sandboxCount: 0, diskBytes: undefined } as const;

describe('checkSandboxBackends', () => {
  it('emits nothing when no backend is selected', () => {
    expect(checkSandboxBackends({ ...base, selected: [] })).toEqual([]);
  });
  it('reports the selected backend ok', () => {
    const [c] = checkSandboxBackends(base);
    expect(c).toMatchObject({ id: 'tools.sandbox-sbx', area: 'tools', status: 'ok', title: 'Sandbox backend (sbx)' });
    expect(c!.detail).toBe('Sbx sandbox backend ready');
  });
  it('warns with the reason as the fix hint when unavailable', () => {
    const [c] = checkSandboxBackends({ ...base, sbx: { ok: false, reason: 'sbx not signed in (run `sbx login`)' } });
    expect(c).toMatchObject({ status: 'warn', fix: { tier: 'report', nextStep: 'sbx not signed in (run `sbx login`)' } });
    expect(c!.detail).toContain('prompted on host');
    expect(c!.detail).toMatch(/^Sbx backend unavailable/);
  });
  it('checks only the selected backend', () => {
    const ids = checkSandboxBackends({ ...base, selected: ['docker'], sbx: { ok: false, reason: 'x' } }).map((c) => c.id);
    expect(ids).toEqual(['tools.sandbox-docker']);
  });
  it('checks both backends when sbx and docker are both selected', () => {
    const out = checkSandboxBackends({ ...base, selected: ['sbx', 'docker'], docker: { ok: false, reason: 'docker not installed' } });
    expect(out.map((c) => [c.id, c.status])).toEqual([['tools.sandbox-sbx', 'ok'], ['tools.sandbox-docker', 'warn']]);
  });
  it('shows sandbox count and size, ok under the threshold', () => {
    const c = checkSandboxBackends({ ...base, sandboxCount: 3, diskBytes: 2e9 }).find((x) => x.id === 'state.sandbox-disk');
    expect(c).toMatchObject({ status: 'ok', title: 'Sandbox disk usage' });
    expect(c!.detail).toContain('3 sandboxes');
    expect(c!.detail).toContain('1.9 GB');
  });
  it('warns above 10 GB', () => {
    const c = checkSandboxBackends({ ...base, sandboxCount: 1, diskBytes: SANDBOX_DISK_WARN_BYTES + 1 }).find((x) => x.id === 'state.sandbox-disk');
    expect(c).toMatchObject({ status: 'warn' });
  });
  it('the threshold is 10 GB in the unit the page prints (binary, DR-8)', () => {
    expect(formatDoctorBytes(SANDBOX_DISK_WARN_BYTES)).toBe('10.0 GB');
  });
  it('exactly 10 GB does not warn', () => {
    expect(checkSandboxBackends({ ...base, sandboxCount: 1, diskBytes: SANDBOX_DISK_WARN_BYTES }).find((x) => x.id === 'state.sandbox-disk')!.status).toBe('ok');
  });
  it('unknown size still reports the count', () => {
    const c = checkSandboxBackends({ ...base, sandboxCount: 1 }).find((x) => x.id === 'state.sandbox-disk');
    expect(c!.detail).toContain('1 sandbox,');
    expect(c!.detail).toContain('size unknown');
  });
  it('skips the disk line when there are no sandboxes', () => {
    expect(checkSandboxBackends(base).some((x) => x.id === 'state.sandbox-disk')).toBe(false);
  });
});

describe('parseDockerSize', () => {
  it.each([['12.3MB (virtual 1.2GB)', 12.3e6], ['0B', 0], ['2GB', 2e9], ['500kB', 500e3], ['1.5TB', 1.5e12]])('%s', (s, n) => {
    expect(parseDockerSize(s)).toBeCloseTo(n, -3);
  });
  it('rejects garbage', () => {
    expect(parseDockerSize('lots')).toBeUndefined();
  });
  it('warns report-only when the Docker VM has under 8 GB, ok at 8 GB', () => {
    const low = checkSandboxBackends({ ...base, selected: ['docker'], dockerMemBytes: 4.8 * 2 ** 30 }).find((c) => c.id === 'tools.docker-memory');
    expect(low).toMatchObject({ status: 'warn', title: 'Docker VM memory', fix: { tier: 'report' } });
    const ok = checkSandboxBackends({ ...base, selected: ['docker'], dockerMemBytes: 8 * 2 ** 30 }).find((c) => c.id === 'tools.docker-memory');
    expect(ok?.status).toBe('ok');
    expect(ok).toMatchObject({ area: 'tools', detail: 'Docker VM memory 8.0 GB' });
    expect(ok?.fix).toBeUndefined();
    expect(low?.detail).toBe('Docker VM memory 4.8 GB');
    expect(JSON.stringify(low?.fix)).toContain('Memory');
    const just = checkSandboxBackends({ ...base, selected: ['docker'], dockerMemBytes: 8 * 2 ** 30 - 1 }).find((c) => c.id === 'tools.docker-memory');
    expect(just?.status).toBe('warn');
  });
  it('no memory check without docker selected or an unknown size', () => {
    expect(checkSandboxBackends({ ...base, dockerMemBytes: 1 * 2 ** 30 }).some((c) => c.id === 'tools.docker-memory')).toBe(false);
    expect(checkSandboxBackends({ ...base, selected: ['docker'] }).some((c) => c.id === 'tools.docker-memory')).toBe(false);
  });
});

const FACTS: SshPreflightFacts = {
  os: 'Linux',
  uid: 1000,
  gid: 1000,
  git: '2.43.0',
  setsid: true,
  setsidW: true,
  tmux: true,
  node: '22.11.0',
  remoteDirOk: true,
  allowTcpForwarding: 'yes',
  freeMb: 50_000,
  coreBin: '/usr/bin/claude',
  coreVersion: '1.2.3',
};

describe('checkSshRemotes (edit 6)', () => {
  it('reports a trusted remote ok with its preflight facts', () => {
    const [c] = checkSshRemotes([{ name: 'devbox', trusted: true, preflight: { ok: true, facts: FACTS, warnings: [] } }]);
    expect(c).toMatchObject({ id: 'tools.sandbox-ssh-devbox', area: 'tools', status: 'ok', title: 'Sandbox remote (devbox)' });
    expect(c!.detail).toContain('ssh devbox ready');
  });

  it('warns with the preflight reason as the fix hint', () => {
    const [c] = checkSshRemotes([{ name: 'devbox', trusted: true, preflight: { ok: false, reason: 'ssh devbox: tmux not found' } }]);
    expect(c).toMatchObject({ status: 'warn', fix: { tier: 'report', nextStep: 'ssh devbox: tmux not found' } });
    expect(c!.detail).toBe('ssh devbox: tmux not found');
  });

  it('an unconfirmed remote warns and is never probed', () => {
    const [c] = checkSshRemotes([{ name: 'devbox', trusted: false }]);
    expect(c).toMatchObject({ id: 'tools.sandbox-ssh-devbox', status: 'warn' });
    expect(c!.detail).toBe('ssh devbox: not confirmed (confirm it in the editor)');
    expect(c!.fix).toMatchObject({ tier: 'report', nextStep: 'confirm it in the editor' });
  });

  it('a preflight warning (no tmux) is a warn naming the reason', () => {
    const [c] = checkSshRemotes([{ name: 'devbox', trusted: true, preflight: { ok: true, facts: { ...FACTS, tmux: false }, warnings: ['ssh devbox: tmux not found'] } }]);
    expect(c).toMatchObject({ status: 'warn', detail: 'ssh devbox: tmux not found' });
  });
});

describe('checkRemoteDiskFacts (edit 6)', () => {
  it('reports the prefix size and the free disk per trusted remote', () => {
    const [c] = checkRemoteDiskFacts([{ remote: 'devbox', workspaces: 2, usedKb: 1024 * 1024, freeKb: 50 * 1024 * 1024 }]);
    expect(c).toMatchObject({ id: 'state.sandbox-disk.devbox', area: 'state', status: 'ok', title: 'Remote sandbox disk (devbox)' });
    expect(c!.detail).toBe('ssh devbox: 2 workspaces, ~1.0 GB, 50.0 GB free');
  });

  it('warns over 10 GB and reports an unknown size without pretending it is zero', () => {
    const over = checkRemoteDiskFacts([{ remote: 'devbox', workspaces: 1, usedKb: 11 * 1024 * 1024, freeKb: undefined }])[0]!;
    expect(over.status).toBe('warn');
    const unknown = checkRemoteDiskFacts([{ remote: 'devbox', workspaces: 1, usedKb: undefined, freeKb: undefined }])[0]!;
    expect(unknown.detail).toContain('size unknown');
  });

  it('a trusted remote whose probe failed is reported, never silently dropped', () => {
    const [c] = checkRemoteDiskFacts([{ remote: 'devbox', error: 'ssh devbox: transport failed: timeout' }]);
    expect(c).toMatchObject({ id: 'state.sandbox-disk.devbox', status: 'warn', detail: 'ssh devbox: transport failed: timeout' });
  });
});

describe('checkStaleRemoteWorkspaces (edit 12)', () => {
  const box = (over: Partial<Parameters<typeof checkStaleRemoteWorkspaces>[0][number]> = {}) => ({
    remote: 'devbox',
    name: 'karst-ab12cd34-7-claude',
    state: 'stopped' as const,
    ageDays: 15,
    sizeKb: 1.5 * 1024 * 1024,
    ...over,
  });

  it('warns for a workspace stopped longer than 14 days, naming its size', () => {
    const [c] = checkStaleRemoteWorkspaces([box()]);
    expect(c).toMatchObject({ id: 'state.sandbox-stale.devbox.karst-ab12cd34-7-claude', area: 'state', status: 'warn' });
    expect(c!.detail).toBe('ssh devbox: karst-ab12cd34-7-claude stopped 15 days, 1.5 GB');
    expect(c!.fix).toMatchObject({ tier: 'report' });
    expect((c!.fix as { nextStep: string }).nextStep).toContain('confirm');
  });

  it('13 days does not warn', () => {
    expect(checkStaleRemoteWorkspaces([box({ ageDays: 13 })])).toEqual([]);
  });

  it('exactly 14 days does not warn; running workspaces never warn', () => {
    expect(checkStaleRemoteWorkspaces([box({ ageDays: STALE_REMOTE_WORKSPACE_DAYS })])).toEqual([]);
    expect(checkStaleRemoteWorkspaces([box({ ageDays: 90, state: 'running' })])).toEqual([]);
  });
});

describe('checkForeignRemoteWorkspaces (edit 13)', () => {
  it('lists a foreign karst-* dir with its age and size, apart from the strays list', () => {
    const [c] = checkForeignRemoteWorkspaces({
      dirs: [{ remote: 'devbox', name: 'karst-deadbeef-7-claude', ageDays: 40, sizeKb: 2048 }],
      errors: [],
    });
    expect(c).toMatchObject({ id: 'state.sandbox-foreign.devbox.karst-deadbeef-7-claude', area: 'state', status: 'warn' });
    expect(c!.detail).toContain('foreign workspace karst-deadbeef-7-claude');
    expect(c!.detail).toContain('40 days');
    expect(c!.detail).toContain('2.0 MB');
    expect(c!.id.startsWith('state.sandbox-orphan.')).toBe(false);
    expect(c!.id.startsWith('state.sandbox-stray.')).toBe(false);
  });

  it('reports a trusted remote whose foreign listing failed', () => {
    const [c] = checkForeignRemoteWorkspaces({ dirs: [], errors: ['ssh devbox: transport failed: nope'] });
    expect(c).toMatchObject({ id: 'state.sandbox-foreign.devbox', status: 'warn', detail: 'ssh devbox: transport failed: nope' });
  });
});

describe('checkSandboxSetupDeclared', () => {
  const repo = (o: Partial<SetupRepoFact> = {}): SetupRepoFact => ({ name: 'app', hasLockfile: true, hasSetup: false, ...o });
  it('warns naming the repo and the suggested setup', () => {
    const [c] = checkSandboxSetupDeclared(['sbx'], [repo()]);
    expect(c).toMatchObject({ id: 'manifest.sandbox-setup.app', area: 'manifest', status: 'warn', title: 'Sandbox setup' });
    expect(c!.detail).toMatch(/^Repository "app" has a lockfile/);
    expect(c!.fix).toMatchObject({ tier: 'report' });
    expect(c!.fix).toMatchObject({ nextStep: expect.stringContaining('sandbox.setup: npm ci') });
  });
  it.each([[{ hasSetup: true }], [{ hasLockfile: false }]])('is silent for %o', (o) => {
    expect(checkSandboxSetupDeclared(['docker'], [repo(o)])).toEqual([]);
  });
  it('is silent without a sandbox backend', () => {
    expect(checkSandboxSetupDeclared([], [repo()])).toEqual([]);
  });
});

describe('state.sandbox-disk with images and build cache', () => {
  const disk = (extra: object) => checkSandboxBackends({ ...base, sandboxCount: 0, diskBytes: undefined, ...extra }).find((x) => x.id === 'state.sandbox-disk');
  it('counts images and cache toward the warning and names the commands', () => {
    const c = disk({ imageBytes: 6e9, cacheBytes: 5e9 })!;
    expect(c.status).toBe('warn');
    expect(c.detail).toBe('0 sandboxes, size unknown, karst images ~5.6 GB, build cache ~4.7 GB');
    expect((c.fix as { nextStep?: string } | undefined)?.nextStep).toContain('docker image rm');
    expect((c.fix as { nextStep?: string } | undefined)?.nextStep).toContain('docker builder prune --filter until=168h --keep-storage 10GB');
  });
  it('is ok under the threshold and absent with nothing to report', () => {
    expect(disk({ imageBytes: 1e9, cacheBytes: 1e9 })!.status).toBe('ok');
    expect(disk({})).toBeUndefined();
  });
});
