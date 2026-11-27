import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedAgyAutonomousState, seedAgyCredentials, seedOpencode1Credentials, seedOpencode2Credentials } from './dockerCredentials.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import { dockerNames } from './dockerNames.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';
import { configureAccounts, resetAccounts } from '../accounts/registry.js';
import { afterEach } from 'vitest';

const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode2' });
const HOST_ENV = { XDG_DATA_HOME: '/karst/oc2/data' };
const SECRET = 'sk-live-SECRET';
const EMPTY = { 'docker run --rm --network none': { stdout: 'No authenticated integrations\n' } };

describe('seedOpencode2Credentials', () => {
  it('skips when the sandbox store already lists a credential', async () => {
    const proc = fakeDockerProcess({ 'docker run --rm --network none': { stdout: 'opencode-go  Go  stored\n' } });
    await expect(seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: HOST_ENV })).resolves.toEqual({ ok: true });
    expect(proc.pipes).toHaveLength(0);
    expect(proc.calls[0]!.args.slice(-5)).toEqual([OPENCODE_IMAGE, 'opencode2', 'auth', 'list', '--standalone']);
  });

  it('pipes the host export into an offline import with the volume XDG store', async () => {
    const proc = fakeDockerProcess(EMPTY);
    await expect(seedOpencode2Credentials({ proc, names, user: { uid: 1001, gid: 1002 }, hostCommand: '/abs/opencode2', hostEnv: HOST_ENV })).resolves.toEqual({ ok: true });
    expect(proc.pipes).toHaveLength(1);
    const { from, to } = proc.pipes[0]!;
    expect(from).toEqual({ command: '/abs/opencode2', args: ['auth', 'export', '--standalone'], env: HOST_ENV });
    expect(to.command).toBe('docker');
    expect(to.args.slice(0, 5)).toEqual(['run', '--rm', '--interactive', '--network', 'none']);
    expect(to.args).toContain('--user');
    expect(to.args).toContain('XDG_DATA_HOME=/home/node/.local/share/opencode/xdg/data');
    expect(to.args.slice(-4)).toEqual(['opencode2', 'auth', 'import', '--standalone']);
  });

  it('never runs the export through run (which would capture its stdout) and never logs output', async () => {
    const debug = vi.fn();
    const proc = fakeDockerProcess({ ...EMPTY, '/abs/opencode2': { stdout: SECRET } });
    await seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: '/abs/opencode2', hostEnv: HOST_ENV, debug });
    expect(proc.calls.some((c) => c.args.includes('export'))).toBe(false);
    const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain(SECRET);
    expect(logged).toBe('[docker] opencode2 credential seed: export exit 0, import exit 0');
  });

  it('seeds when the list probe itself fails', async () => {
    const proc = fakeDockerProcess({ 'docker run': { code: 1 } });
    await seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: {} });
    expect(proc.pipes).toHaveLength(1);
  });

  it('reports a failed export (host not signed in)', async () => {
    const proc = fakeDockerProcess(EMPTY, { fromCode: 1, toCode: 0 });
    await expect(seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: {} })).resolves.toEqual({
      ok: false, reason: 'opencode2 auth export failed (exit 1); sign in on the host first',
    });
  });

  it('reports a failed import', async () => {
    const proc = fakeDockerProcess(EMPTY, { fromCode: 0, toCode: 2 });
    await expect(seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: {} })).resolves.toEqual({
      ok: false, reason: 'opencode2 auth import in the sandbox failed (exit 2)',
    });
  });

  it('logs the skip through debug', async () => {
    const debug = vi.fn();
    const proc = fakeDockerProcess({ 'docker run': { stdout: 'x  y  stored' } });
    await seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: {}, debug });
    expect(debug).toHaveBeenCalledWith('[docker] opencode2 store already has credentials');
  });

  it('fails on a transport failure of the list probe instead of piping blindly', async () => {
    const proc = fakeDockerProcess({ 'docker run --rm --network none': { code: 255, stderr: 'Connection closed by remote host', transport: true } });
    await expect(seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: {} })).resolves.toEqual({
      ok: false, reason: 'opencode2 credential probe did not reach the remote daemon: Connection closed by remote host',
    });
    expect(proc.pipes).toHaveLength(0);
  });

  it('reports exit 255 on the import as a transport failure', async () => {
    const proc = fakeDockerProcess(EMPTY, { fromCode: 0, toCode: 255 });
    await expect(seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: {} })).resolves.toEqual({
      ok: false, reason: 'opencode2 auth import lost the remote connection (exit 255)',
    });
  });
});

describe('seedOpencode1Credentials (remote, T1399)', () => {
  const SECRET_JSON = '{"opencode-go":{"type":"api","key":"sk-live-SECRET"}}';
  const HOST_SHA = createHash('sha256').update(SECRET_JSON).digest('hex');
  const authFile = (): { readonly file: string; readonly dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-auth-'));
    const file = join(dir, 'auth.json');
    writeFileSync(file, SECRET_JSON, { mode: 0o600 });
    return { file, dir };
  };
  const PROBE = 'docker run --rm --network none';

  it('streams the host file into an offline helper when the volume has no auth.json', async () => {
    const { file, dir } = authFile();
    const proc = fakeDockerProcess({ [PROBE]: { code: 1 } });
    const debug = vi.fn();
    await expect(seedOpencode1Credentials({ proc, names, user: { uid: 1001, gid: 1002 }, hostAuthFile: file, debug })).resolves.toEqual({ ok: true });
    expect(proc.pipes).toHaveLength(1);
    const { from, to } = proc.pipes[0]!;
    // The bytes are STREAMED: the path is argv, the content never a JS string.
    expect(from.command).toBe(process.execPath);
    // The extension host binary is Electron: only ELECTRON_RUN_AS_NODE runs `-e` there.
    expect(from.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(from.args[0]).toBe('-e');
    expect(from.args[1]).toContain('createReadStream');
    expect(from.args[2]).toBe(file);
    expect(from.args.join(' ')).not.toContain('sk-live-SECRET');
    expect(to.command).toBe('docker');
    expect(to.args.slice(0, 5)).toEqual(['run', '--rm', '--interactive', '--network', 'none']);
    expect(to.args).toContain('--user');
    expect(to.args).toEqual(expect.arrayContaining([OPENCODE_IMAGE, 'sh', '-c']));
    const script = to.args.at(-1)!;
    expect(script).toContain('umask 077');
    expect(script).toContain('chmod 600');
    expect(script).toContain('mv -f');
    // A mutable helper writes only under the data volume, never a host bind.
    expect(to.args.join(' ')).not.toContain('type=bind');
    expect(to.args.join(' ')).not.toContain(file);
    expect(debug).toHaveBeenCalledWith('[docker] opencode v1 credential seed: read exit 0, write exit 0');
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces a stale volume copy (sha256 differs)', async () => {
    const { file, dir } = authFile();
    const proc = fakeDockerProcess({ [PROBE]: { stdout: `${'0'.repeat(64)}\n` } });
    await expect(seedOpencode1Credentials({ proc, names, user: undefined, hostAuthFile: file })).resolves.toEqual({ ok: true });
    expect(proc.pipes).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips the pipe when the volume copy already matches the host sha256', async () => {
    const { file, dir } = authFile();
    const proc = fakeDockerProcess({ [PROBE]: { stdout: `${HOST_SHA}\n` } });
    const debug = vi.fn();
    await expect(seedOpencode1Credentials({ proc, names, user: undefined, hostAuthFile: file, debug })).resolves.toEqual({ ok: true });
    expect(proc.pipes).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith('[docker] opencode v1 auth.json already matches the host file');
    const probeLine = proc.calls[0]!.args.join(' ');
    expect(probeLine).toContain('sha256sum /home/node/.local/share/opencode/auth.json');
    expect(probeLine).toContain('--network none');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an unreadable host file without touching docker or logging content', async () => {
    const proc = fakeDockerProcess();
    const debug = vi.fn();
    const result = await seedOpencode1Credentials({ proc, names, user: undefined, hostAuthFile: '/nope/auth.json', debug });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('/nope/auth.json');
    expect(proc.calls).toHaveLength(0);
    expect(debug).not.toHaveBeenCalled();
  });

  it('reports a transport failure on the probe, without piping', async () => {
    const { file, dir } = authFile();
    const proc = fakeDockerProcess({ [PROBE]: { code: 255, stderr: 'ssh: connect refused', transport: true } });
    await expect(seedOpencode1Credentials({ proc, names, user: undefined, hostAuthFile: file })).resolves.toEqual({
      ok: false, reason: 'opencode credential probe did not reach the remote daemon: ssh: connect refused',
    });
    expect(proc.pipes).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['the read fails', { fromCode: 1, toCode: 0 }, /could not be streamed \(exit 1\)/],
    ['the write dies on the transport', { fromCode: 0, toCode: 255 }, /lost the remote connection \(exit 255\)/],
    ['the write fails', { fromCode: 0, toCode: 2 }, /credential write in the sandbox failed \(exit 2\)/],
  ])('reports when %s', async (_label, pipeResult, reason) => {
    const { file, dir } = authFile();
    const proc = fakeDockerProcess({ [PROBE]: { code: 1 } }, pipeResult);
    const result = await seedOpencode1Credentials({ proc, names, user: undefined, hostAuthFile: file });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(reason);
    rmSync(dir, { recursive: true, force: true });
  });

  it('never logs the credential bytes on any path', async () => {
    const { file, dir } = authFile();
    const debug = vi.fn();
    const proc = fakeDockerProcess({ [PROBE]: { code: 1 } }, { fromCode: 1, toCode: 0 });
    await seedOpencode1Credentials({ proc, names, user: undefined, hostAuthFile: file, debug });
    const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain(SECRET_JSON);
    expect(logged).not.toContain('sk-live-SECRET');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('seedAgyCredentials', () => {
  it('creates directory segments with mode 0o700 and copies host credential files', async () => {
    const bridgeDir = mkdtempSync(join(tmpdir(), 'karst-bridge-test-'));
    const hostHome = mkdtempSync(join(tmpdir(), 'karst-hosthome-test-'));
    const hostAgyDir = join(hostHome, '.gemini', 'antigravity-cli');
    mkdirSync(hostAgyDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(hostAgyDir, 'antigravity-oauth-token'), 'token-data', { mode: 0o600 });
    writeFileSync(join(hostAgyDir, 'installation_id'), 'id-data', { mode: 0o600 });

    const debug = vi.fn();
    const result = await seedAgyCredentials({ bridgeDir, hostHome, debug });
    expect(result).toEqual({ ok: true });

    const targetDir = join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli');
    expect(existsSync(join(targetDir, 'antigravity-oauth-token'))).toBe(true);
    expect(readFileSync(join(targetDir, 'antigravity-oauth-token'), 'utf8')).toBe('token-data');
    expect(existsSync(join(targetDir, 'installation_id'))).toBe(true);
    expect(readFileSync(join(targetDir, 'installation_id'), 'utf8')).toBe('id-data');
    expect(existsSync(join(bridgeDir, 'antigravity', 'gemini', 'config'))).toBe(true);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('jetski_state.pbtxt'));

    rmSync(bridgeDir, { recursive: true, force: true });
    rmSync(hostHome, { recursive: true, force: true });
  });

  it('refuses when any segment is a symbolic link', async () => {
    const bridgeDir = mkdtempSync(join(tmpdir(), 'karst-bridge-test-'));
    const fakeTarget = mkdtempSync(join(tmpdir(), 'karst-fake-target-'));
    symlinkSync(fakeTarget, join(bridgeDir, 'antigravity'));

    const result = await seedAgyCredentials({ bridgeDir });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/symlink|symbolic link/i);

    rmSync(bridgeDir, { recursive: true, force: true });
    rmSync(fakeTarget, { recursive: true, force: true });
  });

  it('preserves newer destination credential files refreshed in the container', async () => {
    const bridgeDir = mkdtempSync(join(tmpdir(), 'karst-bridge-test-'));
    const hostHome = mkdtempSync(join(tmpdir(), 'karst-hosthome-test-'));
    const hostAgyDir = join(hostHome, '.gemini', 'antigravity-cli');
    const targetDir = join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli');
    mkdirSync(hostAgyDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    writeFileSync(join(hostAgyDir, 'antigravity-oauth-token'), 'old-token');
    utimesSync(join(hostAgyDir, 'antigravity-oauth-token'), new Date(1000), new Date(1000));

    writeFileSync(join(targetDir, 'antigravity-oauth-token'), 'newer-container-token');
    utimesSync(join(targetDir, 'antigravity-oauth-token'), new Date(2000), new Date(2000));

    const result = await seedAgyCredentials({ bridgeDir, hostHome });
    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(targetDir, 'antigravity-oauth-token'), 'utf8')).toBe('newer-container-token');

    rmSync(bridgeDir, { recursive: true, force: true });
    rmSync(hostHome, { recursive: true, force: true });
  });
});

describe('seedAgyCredentials account (AC-55)', () => {
  afterEach(() => resetAccounts());
  it('copies from the account folder of the launch, not the active account', async () => {
    const bridgeDir = mkdtempSync(join(tmpdir(), 'karst-bridge-test-'));
    const active = mkdtempSync(join(tmpdir(), 'karst-active-'));
    const recorded = mkdtempSync(join(tmpdir(), 'karst-recorded-'));
    writeFileSync(join(active, 'antigravity-oauth-token'), 'active-token');
    writeFileSync(join(recorded, 'antigravity-oauth-token'), 'recorded-token');
    const acct = (dir: string) => ({ kind: 'subscription' as const, source: 'folder' as const, dir, env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: dir } });
    configureAccounts({ antigravity: { active: 'a', list: { a: acct(active), r: acct(recorded) } } });
    expect(await seedAgyCredentials({ bridgeDir, account: 'r' })).toEqual({ ok: true });
    const target = join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli', 'antigravity-oauth-token');
    expect(readFileSync(target, 'utf8')).toBe('recorded-token');
    rmSync(bridgeDir, { recursive: true, force: true });
    rmSync(active, { recursive: true, force: true });
    rmSync(recorded, { recursive: true, force: true });
  });
});

describe('seedAgyAutonomousState', () => {
  const cli = (b: string) => join(b, 'antigravity', 'gemini', 'antigravity-cli');
  it('writes onboarding done and autonomous settings, keeping other keys and trust', async () => {
    const b = mkdtempSync(join(tmpdir(), 'karst-auto-'));
    mkdirSync(join(cli(b), 'cache'), { recursive: true });
    writeFileSync(join(cli(b), 'cache', 'onboarding.json'), JSON.stringify({ onboardingComplete: false, enterpriseOnboardingComplete: true, extra: 1 }));
    writeFileSync(join(cli(b), 'settings.json'), JSON.stringify({ model: 'm', toolPermission: 'ask', trustedWorkspaces: ['/other'] }));
    expect(await seedAgyAutonomousState({ bridgeDir: b })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(cli(b), 'cache', 'onboarding.json'), 'utf8'))).toEqual({
      onboardingComplete: true, consumerOnboardingComplete: true, enterpriseOnboardingComplete: true, extra: 1,
    });
    expect(JSON.parse(readFileSync(join(cli(b), 'settings.json'), 'utf8'))).toEqual({
      model: 'm', toolPermission: 'always-proceed', agentMode: 'auto', artifactReviewPolicy: 'agent-decides',
      allowNonWorkspaceAccess: true, trustedWorkspaces: ['/other', '/work/repo'],
    });
    expect(lstatSync(join(cli(b), 'settings.json')).mode & 0o777).toBe(0o600);
    rmSync(b, { recursive: true, force: true });
  });
  it('creates files from scratch and replaces unparseable JSON', async () => {
    const b = mkdtempSync(join(tmpdir(), 'karst-auto-'));
    mkdirSync(cli(b), { recursive: true });
    writeFileSync(join(cli(b), 'settings.json'), '[1,');
    const debug = vi.fn();
    expect(await seedAgyAutonomousState({ bridgeDir: b, debug })).toEqual({ ok: true });
    const s = JSON.parse(readFileSync(join(cli(b), 'settings.json'), 'utf8'));
    expect(s.trustedWorkspaces).toEqual(['/work/repo']);
    expect(JSON.parse(readFileSync(join(cli(b), 'cache', 'onboarding.json'), 'utf8')).enterpriseOnboardingComplete).toBe(false);
    expect(debug).toHaveBeenCalled();
    rmSync(b, { recursive: true, force: true });
  });
  it('refuses a symlinked cache dir', async () => {
    const b = mkdtempSync(join(tmpdir(), 'karst-auto-'));
    const t = mkdtempSync(join(tmpdir(), 'karst-auto-t-'));
    mkdirSync(cli(b), { recursive: true });
    symlinkSync(t, join(cli(b), 'cache'));
    const r = await seedAgyAutonomousState({ bridgeDir: b });
    expect(r.ok).toBe(false);
    expect(existsSync(join(t, 'onboarding.json'))).toBe(false);
    rmSync(b, { recursive: true, force: true });
    rmSync(t, { recursive: true, force: true });
  });
});
