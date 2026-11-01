import { describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedAgyAutonomousState, seedAgyCredentials, seedOpencode2Credentials } from './dockerCredentials.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import { dockerNames } from './dockerNames.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';

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
