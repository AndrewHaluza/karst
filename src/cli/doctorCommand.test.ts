import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import { formatDoctorBytes } from '../doctor/formatBytes.js';
import { STORAGE_WARN_BYTES } from '../doctor/storageCheck.js';
import { DoctorExit, parseDoctorArgs, runDoctorCommand, type GitHealthProbe, type ListSandboxes, type SandboxProbe, type StorageUsageProbe } from './doctorCommand.js';
import { fakeSshProcess, type FakeSshProcess } from '../agent/ssh/fakeSshProcess.js';
import { remoteTrustKey } from '../agent/ssh/remoteTrust.js';
import { sshProjectPrefix } from '../agent/ssh/sshNames.js';
import { listProjectSandboxes } from '../agent/sandboxInventory.js';
import type { RemoteDef } from '../manifest/types.js';

function seed() {
  const store = openStore(':memory:');
  store.db.prepare("INSERT INTO tickets (id, key, stage_current) VALUES (1, 'T-1', 'done')").run();
  // pid 2147483646 is not alive: a dead recorded server.
  store.db
    .prepare("INSERT INTO servers (ticket_id, repo, pid, status, kind) VALUES (1, 'r', 2147483646, 'running', 'service')")
    .run();
  return store;
}
const status = (s: ReturnType<typeof seed>): string =>
  (s.db.prepare('SELECT status FROM servers').get() as { status: string }).status;

async function run(store: ReturnType<typeof seed>, rest: string[]): Promise<DoctorExit> {
  try {
    await runDoctorCommand(store, ':memory:', undefined, ['doctor', ...rest], {});
  } catch (e) {
    if (e instanceof DoctorExit) return e;
    throw e;
  }
  throw new Error('expected DoctorExit');
}

describe('karst doctor command', () => {
  it('parses flags and rejects junk', async () => {
    expect(parseDoctorArgs(['doctor', '--fix', '--json', '--area', 'state'])).toEqual({ fix: true, json: true, areas: ['state'], only: [] });
    expect(() => parseDoctorArgs(['doctor', '--area'])).toThrow(/needs a value/);
    expect(() => parseDoctorArgs(['doctor', '--area', 'nope'])).toThrow(/--area/);
    expect(() => parseDoctorArgs(['doctor', 'x'])).toThrow(/unexpected/);
  });

  it('parses repeatable --only ids without splitting them', () => {
    expect(parseDoctorArgs(['doctor', '--fix', '--only', 'a', '--only', 'b']).only).toEqual(['a', 'b']);
    // A check id can hold a repo name or ticket key, so a comma is never a separator.
    expect(
      parseDoctorArgs(['doctor', '--fix', '--only', 'state.worktree-prune.T1320.api,web']).only,
    ).toEqual(['state.worktree-prune.T1320.api,web']);
    expect(parseDoctorArgs(['doctor', '--fix', '--only', 'manifest.sandbox-setup.my.repo']).only).toEqual([
      'manifest.sandbox-setup.my.repo',
    ]);
  });

  it('rejects --only without a value or without --fix', () => {
    expect(() => parseDoctorArgs(['doctor', '--fix', '--only'])).toThrow(/karst doctor: --only needs a value/);
    expect(() => parseDoctorArgs(['doctor', '--only', 'a'])).toThrow(/karst doctor: --only needs --fix/);
  });

  it('rejects --only without --fix before running any check', async () => {
    const store = seed();
    await expect(runDoctorCommand(store, ':memory:', undefined, ['doctor', '--json', '--only', 'state.schema'], {})).rejects.toThrow(
      /--only needs --fix/,
    );
    expect(status(store)).toBe('running');
  });

  it('without --fix makes no writes', async () => {
    const store = seed();
    const out = (await run(store, ['--json', '--area', 'state']));
    const report = JSON.parse(out.output);
    expect(report.fixRequested).toBe(false);
    expect(report.applied).toEqual([]);
    expect(report.checks.some((c: { id: string }) => c.id.startsWith('state.server-dead'))).toBe(true);
    expect(status(store)).toBe('running');
  });

  it('--fix marks the dead server stopped and logs it', async () => {
    const store = seed();
    const report = JSON.parse((await run(store, ['--fix', '--json', '--area', 'state'])).output);
    expect(status(store)).toBe('stopped');
    expect(report.applied).toHaveLength(1);
    expect(report.applied[0]).toMatchObject({ ok: true });
    expect(report.checks.some((c: { id: string }) => c.id.startsWith('state.server-dead'))).toBe(false);
  });

  it('--fix --only applies just the named auto fix and leaves the other one alone', async () => {
    const store = seed();
    store.db
      .prepare("INSERT INTO servers (ticket_id, repo, pid, status, kind) VALUES (1, 'r2', 2147483645, 'running', 'service')")
      .run();
    const rows = store.db.prepare('SELECT id, status FROM servers ORDER BY id').all() as { id: number; status: string }[];
    const [first, second] = rows;
    if (!first || !second) throw new Error('expected two servers');

    const report = JSON.parse(
      (await run(store, ['--fix', '--json', '--only', `state.server-dead.${first.id}`, '--area', 'state'])).output,
    );

    const after = store.db.prepare('SELECT id, status FROM servers ORDER BY id').all() as { id: number; status: string }[];
    expect(after).toEqual([
      { id: first.id, status: 'stopped' },
      { id: second.id, status: 'running' },
    ]);
    expect(report.applied).toEqual([expect.objectContaining({ checkId: `state.server-dead.${first.id}`, ok: true })]);
  });

  it('--fix --only reports an id that is gone as skipped and applies nothing else', async () => {
    const store = seed();
    const report = JSON.parse(
      (await run(store, ['--fix', '--json', '--only', 'state.server-dead.999', '--area', 'state'])).output,
    );
    expect(report.applied).toContainEqual({
      checkId: 'state.server-dead.999',
      what: 'skipped state.server-dead.999',
      why: 'the problem is gone',
      evidence: 'not found when the fix ran',
      ok: false,
    });
    expect(status(store)).toBe('running');
  });

  it('exits 1 when a check fails (schema mismatch is not fixable)', async () => {
    const store = seed();
    store.db.pragma('user_version = 1');
    expect((await run(store, ['--area', 'state'])).code).toBe(1);
  });

  it('renders text by default', async () => {
    expect((await run(seed(), ['--area', 'state'])).output).toMatch(/ok, \d+ warn, \d+ fail/);
  });

  it('wiring: a missing KARST_CLI path fails; a real js file passes', async () => {
    const wiring = async (cli: string): Promise<{ status: string }> => {
      try {
        await runDoctorCommand(seed(), ':memory:', undefined, ['doctor', '--json', '--area', 'wiring'], { KARST_CLI: cli });
      } catch (e) {
        return JSON.parse((e as DoctorExit).output).checks.find((c: { id: string }) => c.id === 'wiring.cli');
      }
      throw new Error('expected DoctorExit');
    };
    expect((await wiring('/nonexistent/main.js')).status).toBe('fail');
    expect((await wiring(join(process.cwd(), 'vitest.config.ts'))).status).toBe('fail'); // exists but not .js
    expect((await wiring(join(process.cwd(), 'scripts', 'copy-assets.mjs'))).status).toBe('fail'); // .mjs is not .js
    const dir = mkdtempSync(join(tmpdir(), 'doctor-cli-'));
    try {
      writeFileSync(join(dir, 'main.js'), '');
      expect((await wiring(join(dir, 'main.js'))).status).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('manifest: reports a manifest that fails to load', async () => {
    let out = '';
    try {
      await runDoctorCommand(seed(), ':memory:', '/nonexistent/karst.yml', ['doctor', '--json', '--area', 'manifest'], {});
    } catch (e) {
      out = (e as DoctorExit).output;
    }
    const report = JSON.parse(out);
    expect(report.checks.find((c: { id: string }) => c.id === 'manifest.valid').status).toBe('fail');
  });

  it('stuck: an idle impl ticket with no session is reported, and never auto-fixed', async () => {
    const store = seed();
    store.db.prepare("INSERT INTO tickets (id, key, stage_current, agent_state, updated_at) VALUES (2, 'T-2', 'impl', 'idle', '2020-01-01 00:00:00')").run();
    const report = JSON.parse((await run(store, ['--fix', '--json', '--area', 'state'])).output);
    const stuck = report.checks.find((c: { id: string }) => c.id === 'state.stuck.T-2');
    expect(stuck.fix.tier).toBe('report');
  });

  it('stuck: awaiting-merge (ship) and conflicted tickets are not flagged', async () => {
    const store = seed();
    store.db.prepare("INSERT INTO tickets (id, key, stage_current, agent_state, updated_at) VALUES (3, 'T-3', 'ship', 'idle', '2020-01-01 00:00:00')").run();
    store.db.prepare("INSERT INTO tickets (id, key, stage_current, agent_state, updated_at) VALUES (4, 'T-4', 'impl', 'idle', '2020-01-01 00:00:00')").run();
    store.db.prepare("INSERT INTO merge_checks (ticket_id, repo, state, files, checked_at) VALUES (4, 'r', 'conflicted', '[]', '2020-01-01')").run();
    const ids = JSON.parse((await run(store, ['--json', '--area', 'state'])).output).checks.map((c: { id: string }) => c.id);
    expect(ids).not.toContain('state.stuck.T-3');
    expect(ids).not.toContain('state.stuck.T-4');
  });

  it('storage: lists state.storage right after state.wal in the state area', async () => {
    const ids = JSON.parse((await run(seed(), ['--json', '--area', 'state'])).output).checks.map((c: { id: string }) => c.id);
    expect(ids).toContain('state.storage');
    expect(ids.indexOf('state.storage')).toBe(ids.indexOf('state.wal') + 1);
  });

  async function doctorWithDbPath(dbPath: string, rest: string[], storageUsage?: StorageUsageProbe): Promise<{ checks: { id: string; status: string; detail: string; fix?: { tier: string } }[]; applied: { checkId: string }[] }> {
    try {
      await runDoctorCommand(seed(), dbPath, undefined, ['doctor', ...rest], {}, undefined, undefined, undefined, storageUsage);
    } catch (e) {
      return JSON.parse((e as DoctorExit).output);
    }
    throw new Error('expected DoctorExit');
  }

  it('storage: measures dirname(dbPath) and names the largest children', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-storage-cli-'));
    const dbPath = join(dir, 'karst.db');
    try {
      mkdirSync(join(dir, 'artifacts'));
      writeFileSync(join(dir, 'artifacts', 'a.bin'), 'x'.repeat(2048));
      writeFileSync(dbPath, 'x'.repeat(1024));

      const report = await doctorWithDbPath(dbPath, ['--json', '--area', 'state']);
      const storage = report.checks.find((c) => c.id === 'state.storage');

      expect(storage).toMatchObject({ status: 'ok' });
      expect(storage?.detail).toBe(
        `Karst storage is ${formatDoctorBytes(3072)} (artifacts ${formatDoctorBytes(2048)}, karst.db ${formatDoctorBytes(1024)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('storage: warns through an injected probe for dirname(dbPath) and --fix never applies it', async () => {
    const probe = vi.fn<StorageUsageProbe>(() => ({ totalBytes: STORAGE_WARN_BYTES, entries: [], partial: false }));
    const dbPath = join('/tmp', 'karst-store', 'karst.db');

    const report = await doctorWithDbPath(dbPath, ['--fix', '--json', '--area', 'state'], probe);

    expect(probe).toHaveBeenCalledWith(dirname(dbPath));
    expect(report.checks.find((c) => c.id === 'state.storage')).toMatchObject({ status: 'warn', fix: { tier: 'report' } });
    expect(report.applied.some((a) => a.checkId === 'state.storage')).toBe(false);
  });

  it('tools: inotify watch check is emitted on linux and skipped on non-linux', async () => {
    const store = seed();
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const darwinReport = JSON.parse((await run(store, ['--json', '--area', 'tools'])).output);
      expect(darwinReport.checks.some((c: { id: string }) => c.id === 'tools.inotify-watches')).toBe(false);

      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const linuxReport = JSON.parse((await run(store, ['--json', '--area', 'tools'])).output);
      expect(linuxReport.checks.some((c: { id: string }) => c.id === 'tools.inotify-watches')).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});


describe('karst doctor sandbox orphans (arch:AC-32)', () => {
  const MANIFEST = 'host: localhost\nportRange: [4000, 4999]\nbaselineBranch: develop\nrepositories:\n  app:\n    repoPath: ../app\n';
  async function doctorWith(backend: string, list: ListSandboxes, probe?: SandboxProbe, area = 'state', gitHealth?: GitHealthProbe): Promise<{ id: string; status: string }[]> {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-sbx-'));
    const path = join(dir, 'karst.yml');
    writeFileSync(path, `${MANIFEST}${backend}`);
    const store = seed();
    store.db.prepare("INSERT INTO tickets (id, key, stage_current, archived_at) VALUES (2, 'T-2', 'impl', datetime('now'))").run();
    try {
      await runDoctorCommand(store, ':memory:', path, ['doctor', '--json', '--area', area], {}, list, probe, gitHealth);
    } catch (e) {
      return JSON.parse((e as DoctorExit).output).checks;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    throw new Error('expected DoctorExit');
  }
  const box = (ticketId: number) => ({ runner: 'sbx' as const, name: `karst-ab12cd34-${ticketId}-claude`, ticketId, core: 'claude', state: 'stopped' as const });

  it('reports a sandbox of an archived ticket, not of a live one', async () => {
    const list = vi.fn(async () => ({ sandboxes: [box(1), box(2)], errors: [] }));
    const checks = await doctorWith('agentBackend: sbx\n', list);
    expect(list).toHaveBeenCalledWith(expect.stringMatching(/karst\.yml$/), expect.objectContaining({ globalStorageDir: expect.any(String) }));
    const orphans = checks.filter((c) => c.id.startsWith('state.sandbox-orphan.'));
    expect(orphans).toEqual([expect.objectContaining({ id: 'state.sandbox-orphan.karst-ab12cd34-2-claude', status: 'warn' })]);
  });

  it('state: git health reports each distinct common dir once', async () => {
    const probe = vi.fn((name: string, repoPath: string) => ({ name, repoPath, commonDir: '/x/.git', packCount: 99, autoPackLimit: 50 }));
    const checks = await doctorWith('  api:\n    repoPath: ../app\n', vi.fn(async () => ({ sandboxes: [], errors: [] })), undefined, 'state', probe);
    expect(checks.filter((c) => c.id.startsWith('state.git-pack-count.')).map((c) => c.id)).toEqual(['state.git-pack-count.app']);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('without a sandbox backend never lists sandboxes', async () => {
    const list = vi.fn(async () => ({ sandboxes: [box(2)], errors: [] }));
    const checks = await doctorWith('', list);
    expect(list).not.toHaveBeenCalled();
    expect(checks.some((c) => c.id.startsWith('state.sandbox-orphan.'))).toBe(false);
  });

  const ready: SandboxProbe = { backends: async () => ({ sbx: { ok: true }, docker: { ok: false, reason: 'docker not installed (not on PATH)' } }), dockerDisk: async () => 12e9 };

  it('reports the selected backend status in the tools area', async () => {
    const list = vi.fn(async () => ({ sandboxes: [], errors: [] }));
    const checks = await doctorWith('agentBackend: sbx\n', list, ready, 'tools');
    expect(checks).toContainEqual(expect.objectContaining({ id: 'tools.sandbox-sbx', status: 'ok' }));
  });

  it('warns when the selected backend is unavailable', async () => {
    const list = vi.fn(async () => ({ sandboxes: [], errors: [] }));
    const checks = await doctorWith('agentBackend: docker\n', list, ready, 'tools');
    expect(checks).toContainEqual(expect.objectContaining({ id: 'tools.sandbox-docker', status: 'warn' }));
  });

  it('checks both backends when different cores select sbx and docker', async () => {
    const list = vi.fn(async () => ({ sandboxes: [], errors: [] }));
    const backends = vi.fn(ready.backends);
    const checks = await doctorWith('agentBackends:\n  claude: sbx\n  opencode: docker\n', list, { ...ready, backends }, 'tools');
    expect(backends).toHaveBeenCalledWith({ sbx: true, docker: true, ssh: false });
    expect(checks).toContainEqual(expect.objectContaining({ id: 'tools.sandbox-sbx', status: 'ok' }));
    expect(checks).toContainEqual(expect.objectContaining({ id: 'tools.sandbox-docker', status: 'warn' }));
  });

  it('probes only the selected backend', async () => {
    const backends = vi.fn(ready.backends);
    await doctorWith('agentBackends:\n  codex: sbx\n', vi.fn(async () => ({ sandboxes: [], errors: [] })), { ...ready, backends }, 'tools');
    expect(backends).toHaveBeenCalledWith({ sbx: true, docker: false, ssh: false });
  });

  it('warns about disk above 10 GB in the state area', async () => {
    const dockerBox = { runner: 'docker' as const, name: 'karst-ab12cd34-1-opencode', ticketId: 1, core: 'opencode', state: 'running' as const };
    const list = vi.fn(async () => ({ sandboxes: [dockerBox], errors: [] }));
    const checks = await doctorWith('agentBackend: docker\n', list, ready);
    expect(checks).toContainEqual(expect.objectContaining({ id: 'state.sandbox-disk', status: 'warn' }));
  });

  it('host backend runs no probes', async () => {
    const probe: SandboxProbe = { backends: vi.fn(ready.backends), dockerDisk: vi.fn(ready.dockerDisk) };
    await doctorWith('agentBackend: host\n', vi.fn(async () => ({ sandboxes: [], errors: [] })), probe, 'tools');
    expect(probe.backends).not.toHaveBeenCalled();
  });
});

describe('karst doctor ssh remotes (edit 6)', () => {
  const REMOTE: RemoteDef = { host: 'devbox.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
  const INSTALL_ID = 'b'.repeat(32);
  const PREFLIGHT = [
    'os=Linux',
    'uid=1000',
    'gid=1000',
    'git=git version 2.43.0',
    'setsid=yes',
    'setsidW=yes',
    'tmux=yes',
    'node=v22.11.0',
    'remoteDirStat=1000 700',
    'allowTcpForwarding=yes',
    'freeKb=51200000',
    'coreBin=/usr/bin/claude',
    'coreVersion=1.2.3',
  ].join('\n');

  interface RemoteDoctor {
    readonly checks: { id: string; status: string; detail: string; fix?: { tier: string } }[];
    readonly ssh: FakeSshProcess;
    /** The manifest path the doctor hashed into the ssh prefix. */
    readonly manifestPath: string;
  }

  async function remoteDoctor(opts: {
    trust?: 'ok' | 'missing' | 'changed';
    area?: string;
    sandboxes?: { runner: 'ssh'; name: string; ticketId: number; core: string; state: 'running' | 'stopped'; remote: string }[];
    workspaceAges?: string;
    foreign?: string;
    /** A path the caller already hashed into an ssh name (the doctor uses the manifest path as the prefix input). */
    manifestPath?: string;
  } = {}): Promise<RemoteDoctor> {
    const dir = opts.manifestPath === undefined ? mkdtempSync(join(tmpdir(), 'doctor-ssh-')) : dirname(opts.manifestPath);
    // The launcher hashes the manifest path; the doctor must use the same string.
    const manifestPath = opts.manifestPath ?? join(dir, 'karst.yml');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      manifestPath,
      [
        'host: localhost',
        'portRange: [4000, 4999]',
        'baselineBranch: develop',
        'agentBackends:',
        '  claude: ssh:devbox',
        'remotes:',
        '  devbox:',
        '    host: devbox.example.com',
        '    user: karst',
        '    mode: direct',
        '    remoteDir: /srv/karst',
        'repositories:',
        '  app:',
        '    repoPath: ../app',
        '',
      ].join('\n'),
    );
    mkdirSync(join(dir, 'ssh'), { recursive: true });
    writeFileSync(join(dir, 'ssh', 'install-id'), `${INSTALL_ID}\n`);
    if (opts.trust !== 'missing') {
      const key = opts.trust === 'changed' ? remoteTrustKey('devbox', { ...REMOTE, host: 'changed.example.com' }) : remoteTrustKey('devbox', REMOTE);
      writeFileSync(join(dir, 'ssh-trust.json'), JSON.stringify({ devbox: key }));
    }
    const ssh = fakeSshProcess({
      '# karst-ssh-preflight': { stdout: PREFLIGHT },
      '# karst-ssh-remote-disk': { stdout: 'count=1\nusedKb=2048\nfreeKb=51200000\n' },
      '# karst-ssh-remote-workspaces': { stdout: opts.workspaceAges ?? '' },
      '# karst-ssh-foreign-list': { stdout: opts.foreign ?? '' },
    });
    const list = vi.fn(async () => ({ sandboxes: opts.sandboxes ?? [], errors: [] }));
    try {
      await runDoctorCommand(seed(), join(dir, 'karst.db'), manifestPath, ['doctor', '--json', '--area', opts.area ?? 'tools'], {}, list, undefined, undefined, undefined, ssh);
    } catch (e) {
      if (!(e instanceof DoctorExit)) throw e;
      return { checks: JSON.parse(e.output).checks, ssh, manifestPath };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    throw new Error('expected DoctorExit');
  }

  it('runs the preflight of a trusted remote and reports it ok', async () => {
    const { checks, ssh } = await remoteDoctor({ trust: 'ok' });
    expect(checks).toContainEqual(expect.objectContaining({ id: 'tools.sandbox-ssh-devbox', status: 'ok' }));
    expect(ssh.calls.some((c) => (c.args.at(-1) ?? '').includes('# karst-ssh-preflight'))).toBe(true);
  });

  it('an unconfirmed remote reports "not confirmed" and makes zero ssh calls', async () => {
    for (const trust of ['missing', 'changed'] as const) {
      const { checks, ssh } = await remoteDoctor({ trust });
      expect(checks).toContainEqual(expect.objectContaining({ id: 'tools.sandbox-ssh-devbox', status: 'warn', detail: 'ssh devbox: not confirmed (confirm it in the editor)' }));
      expect(ssh.calls).toHaveLength(0);
    }
  });

  it('the real inventory also makes zero ssh calls for an unconfirmed remote (trust first, D553 C1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-ssh-inv-'));
    const manifestPath = join(dir, 'karst.yml');
    const name = `${sshProjectPrefix(manifestPath, INSTALL_ID)}-7-claude`;
    // No ssh-trust.json: the lister must stop before its first `ls`.
    mkdirSync(join(dir, 'ssh'), { recursive: true });
    writeFileSync(join(dir, 'ssh', 'install-id'), `${INSTALL_ID}\n`);
    const ssh = fakeSshProcess({ '# karst-ssh-inventory': { stdout: `__KARST_DIRS__\n${name}\n` } });
    const empty = { run: async () => ({ code: 0, stdout: '', stderr: '' }) };
    const list: ListSandboxes = (projectRoot, ctx) =>
      listProjectSandboxes({
        projectRoot,
        sbx: empty,
        docker: empty,
        remotes: ctx?.remotes,
        installId: INSTALL_ID,
        trustDir: ctx?.globalStorageDir,
        ssh,
      });
    try {
      const store = seed();
      store.db.prepare("INSERT INTO tickets (id, key, stage_current) VALUES (7, 'T-7', 'impl')").run();
      try {
        await runDoctorCommand(store, join(dir, 'karst.db'), manifestPath, ['doctor', '--json', '--area', 'state'], {}, list, undefined, undefined, undefined, ssh);
      } catch (e) {
        if (!(e instanceof DoctorExit)) throw e;
        const checks = JSON.parse(e.output).checks as { id: string; status: string }[];
        expect(checks.some((c) => c.id === 'state.sandbox-stale.devbox.' + name)).toBe(false);
        expect(checks.some((c) => c.id.startsWith('state.sandbox-disk.devbox'))).toBe(false);
      }
      expect(ssh.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('state: a trusted remote gets its disk facts; an unconfirmed one is skipped', async () => {
    const trusted = await remoteDoctor({ trust: 'ok', area: 'state' });
    expect(trusted.checks).toContainEqual(expect.objectContaining({ id: 'state.sandbox-disk.devbox', status: 'ok' }));
    expect(trusted.checks.find((c) => c.id === 'state.sandbox-disk.devbox')!.detail).toContain('1 workspace');
    const untrusted = await remoteDoctor({ trust: 'missing', area: 'state' });
    expect(untrusted.checks.some((c) => c.id === 'state.sandbox-disk.devbox')).toBe(false);
    expect(untrusted.ssh.calls).toHaveLength(0);
  });

  it('state: a workspace stopped 15 days warns with its size; 13 days does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-ssh-prefix-'));
    const manifestPath = join(dir, 'karst.yml');
    const name = `${sshProjectPrefix(manifestPath, INSTALL_ID)}-7-claude`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const box = { runner: 'ssh' as const, name, ticketId: 7, core: 'claude', state: 'stopped' as const, remote: 'devbox' };
    try {
      const fifteen = await remoteDoctor({ trust: 'ok', area: 'state', sandboxes: [box], workspaceAges: `${name}\t${String(nowSeconds - 15 * 86_400)}\t2048\n`, manifestPath });
      const stale = fifteen.checks.find((c) => c.id === `state.sandbox-stale.devbox.${name}`);
      expect(stale).toMatchObject({ status: 'warn' });
      expect(stale!.detail).toBe(`ssh devbox: ${name} stopped 15 days, 2.0 MB`);
      const thirteen = await remoteDoctor({ trust: 'ok', area: 'state', sandboxes: [box], workspaceAges: `${name}\t${String(nowSeconds - 13 * 86_400)}\t2048\n`, manifestPath });
      expect(thirteen.checks.some((c) => c.id.startsWith(`state.sandbox-stale.devbox.`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('state: foreign karst-* dirs are listed with age and size, never as strays', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const foreign = `karst-deadbeef-7-claude\t${String(nowSeconds - 40 * 86_400)}\t2048\t-\t0\tno\n`;
    const { checks } = await remoteDoctor({ trust: 'ok', area: 'state', foreign });
    const c = checks.find((x) => x.id === 'state.sandbox-foreign.devbox.karst-deadbeef-7-claude');
    expect(c).toMatchObject({ status: 'warn' });
    expect(c!.detail).toContain('foreign workspace');
    expect(c!.detail).toContain('40 days');
    expect(checks.some((x) => x.id.startsWith('state.sandbox-stray.'))).toBe(false);
  });
});

describe('karst doctor sandbox setup (manifest area)', () => {
  async function manifestChecks(backend: string, lockfile: boolean): Promise<{ id: string; status: string }[]> {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-setup-'));
    const repoDir = join(dir, 'app');
    mkdirSync(repoDir);
    if (lockfile) writeFileSync(join(repoDir, 'package-lock.json'), '{}');
    const path = join(dir, 'karst.yml');
    writeFileSync(path, `host: localhost\nportRange: [4000, 4999]\nbaselineBranch: develop\nrepositories:\n  app:\n    repoPath: ${repoDir}\n${backend}`);
    try {
      await runDoctorCommand(seed(), ':memory:', path, ['doctor', '--json', '--area', 'manifest'], {});
    } catch (e) {
      return JSON.parse((e as DoctorExit).output).checks;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    throw new Error('expected DoctorExit');
  }
  it('warns for a lockfile repo without sandbox.setup when sbx is selected', async () => {
    expect(await manifestChecks('agentBackend: sbx\n', true)).toContainEqual(expect.objectContaining({ id: 'manifest.sandbox-setup.app', status: 'warn' }));
  });
  it('is silent without a lockfile or without a sandbox backend', async () => {
    expect((await manifestChecks('agentBackend: sbx\n', false)).some((c) => c.id.startsWith('manifest.sandbox-setup.'))).toBe(false);
    expect((await manifestChecks('', true)).some((c) => c.id.startsWith('manifest.sandbox-setup.'))).toBe(false);
  });
});
