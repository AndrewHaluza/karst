import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { fakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { REMOTE_TRUST_FILE, remoteTrustKey } from '../../agent/ssh/remoteTrust.js';
import { sshProjectPrefix } from '../../agent/ssh/sshNames.js';
import { describeRemoteStrays, findRemoteStrays, findStrays, parseRemoteStrays, remoteStraysScript, removeStrays } from './sandboxStrays.js';
import { sshArgv } from '../../agent/ssh/sshProcess.js';
import { OPENCODE_IMAGE_REVISION } from '../../agent/docker/dockerImage.js';
import type { RemoteDef } from '../../manifest/types.js';

let root: string | undefined;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

const n = (project: string, id: number, core = 'claude'): string => sbxName({ projectRoot: project, ticketId: id, core });

function setup(answers: Record<string, { stdout?: string; code?: number }>) {
  root = mkdtempSync(join(tmpdir(), 'karst-strays-'));
  const project = join(root, 'karst.yml');
  const docker = fakeSbxProcess(answers);
  return { project, docker };
}

describe('findStrays / removeStrays', () => {
  it('clone dirs with no sandbox: closed ticket removable, open ticket reported only', async () => {
    const { project, docker } = setup({});
    for (const id of [3, 4, 5]) mkdirSync(join(root!, '.karst', 'sbx-clones', n(project, id)), { recursive: true });
    const inv = { sandboxes: [{ runner: 'sbx' as const, name: n(project, 5), ticketId: 5, core: 'claude', state: 'running' as const }], errors: [] };
    const deps = { projectRoot: project, docker, liveTicketIds: new Set([4, 5]) };
    const strays = await findStrays(deps, inv);
    expect(strays.map((s) => [s.name, s.removable])).toEqual([[n(project, 3), true], [n(project, 4), false]]);
    expect(await removeStrays(deps, strays)).toEqual([]);
    expect(existsSync(join(root!, '.karst', 'sbx-clones', n(project, 3)))).toBe(false);
    expect(existsSync(join(root!, '.karst', 'sbx-clones', n(project, 4)))).toBe(true);
  });

  it('docker volumes, networks and proxies without a container; others\' and listed ones are untouched', async () => {
    const { project, docker } = setup({});
    const a = n(project, 3, 'opencode'), live = n(project, 4, 'opencode');
    const answers = {
      'docker volume ls': { stdout: `${a}-repo\n${a}-data\n${live}-repo\nkarst-deadbeef-9-opencode-repo\n` },
      'docker network ls': { stdout: `${a}-net\n` },
      'docker ps': { stdout: `${a}-proxy\n${live}-proxy\n` },
    };
    const proc = fakeSbxProcess(answers);
    const inv = { sandboxes: [{ runner: 'docker' as const, name: live, ticketId: 4, core: 'opencode', state: 'running' as const }], errors: [] };
    const deps = { projectRoot: project, docker: proc, liveTicketIds: new Set([4]) };
    void docker;
    const strays = await findStrays(deps, inv);
    expect(strays.map((s) => `${s.kind}:${s.name}`).sort()).toEqual([`network:${a}-net`, `proxy:${a}-proxy`, `volume:${a}-data`, `volume:${a}-repo`]);
    expect(await removeStrays(deps, strays)).toEqual([]);
    const rms = proc.calls.filter((c) => c.args.includes('rm')).map((c) => c.args.join(' '));
    expect(rms).toContain(`volume rm --force ${a}-repo`);
    expect(rms).toContain(`network rm ${a}-net`);
    expect(rms).toContain(`rm --force ${a}-proxy`);
    expect(rms.join('\n')).not.toContain(live);
  });

  it('releases the proxy grant of a removable sbx clone dir, and of no open ticket', async () => {
    const { project, docker } = setup({});
    for (const id of [3, 4]) mkdirSync(join(root!, '.karst', 'sbx-clones', n(project, id)), { recursive: true });
    const released: string[] = [];
    const deps = { projectRoot: project, docker, liveTicketIds: new Set([4]), releaseGrant: async (name: string) => { released.push(name); } };
    await removeStrays(deps, await findStrays(deps, { sandboxes: [], errors: [] }));
    expect(released).toEqual([n(project, 3)]);
  });

  it('reports a failed grant release and still removes the clone dir', async () => {
    const { project, docker } = setup({});
    mkdirSync(join(root!, '.karst', 'sbx-clones', n(project, 3)), { recursive: true });
    const deps = { projectRoot: project, docker, liveTicketIds: new Set<number>(), releaseGrant: async () => { throw new Error('store down'); } };
    const failed = await removeStrays(deps, await findStrays(deps, { sandboxes: [], errors: [] }));
    expect(failed).toEqual([`clone-dir ${n(project, 3)}: store down`]);
  });

  it('a failed listing proves nothing stray', async () => {
    const { project, docker } = setup({});
    mkdirSync(join(root!, '.karst', 'sbx-clones', n(project, 3)), { recursive: true });
    const strays = await findStrays({ projectRoot: project, docker, liveTicketIds: new Set() }, { sandboxes: [], errors: ['sbx ls failed: x', 'docker ps failed: y'] });
    expect(strays).toEqual([]);
  });
});

describe('findRemoteStrays (D824, edit 4)', () => {
  const INSTALL_ID = '0123456789abcdef0123456789abcdef';
  const PREFIX = sshProjectPrefix('/p', INSTALL_ID);
  const DIRECT: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
  const DOCKER: RemoteDef = { ...DIRECT, mode: 'docker' };

  function trust(target: RemoteDef = DIRECT): string {
    const dir = mkdtempSync(join(tmpdir(), 'karst-strays-trust-'));
    writeFileSync(join(dir, REMOTE_TRUST_FILE), JSON.stringify({ devbox: remoteTrustKey('devbox', target) }));
    return dir;
  }

  function controlDir(): string {
    return mkdtempSync(join(tmpdir(), 'karst-strays-control-'));
  }

  const script = (dirs: readonly string[], assets: readonly string[] = []): string =>
    ['__KARST_STRAY_DIRS__', ...dirs, '__KARST_STRAY_ASSETS__', ...assets].join('\n');

  it('reports this prefix\'s half-made dirs and unused assets; another install\'s dirs are not strays', async () => {
    const ssh = fakeSshProcess({
      'karst-ssh-strays': { stdout: script([`${PREFIX}-7-opencode2`, `${PREFIX}-8-codex`, 'karst-deadbeef-1-claude'], ['r3', OPENCODE_IMAGE_REVISION]) },
    });
    const inv = { sandboxes: [{ runner: 'ssh' as const, remote: 'devbox', name: `${PREFIX}-7-opencode2`, ticketId: 7, core: 'opencode2', state: 'running' as const }], errors: [] };
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DOCKER }, installId: INSTALL_ID, trustDir: trust(DOCKER), ssh, controlDir: controlDir(), inventory: inv,
    });
    expect(r.errors).toEqual([]);
    expect(r.strays).toEqual([
      { kind: 'half-made', remote: 'devbox', name: `${PREFIX}-8-codex`, path: `/srv/karst/${PREFIX}-8-codex` },
      { kind: 'assets', remote: 'devbox', name: 'r3', path: '/srv/karst/.karst-assets/r3' },
    ]);
    // Reported, never removed: no rm in any remote script.
    expect(ssh.calls.every((c) => !(c.args.at(-1) ?? '').includes('rm -rf'))).toBe(true);
  });

  it('lists a forgotten stray from the inventory without another ssh call', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([]) } });
    const inv = { sandboxes: [{ runner: 'ssh' as const, remote: 'devbox', name: `${PREFIX}-9-claude`, ticketId: 9, core: 'claude', state: 'stopped' as const, stray: true as const }], errors: [] };
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, controlDir: controlDir(), inventory: inv,
    });
    expect(r.strays).toEqual([{ kind: 'forgotten', remote: 'devbox', name: `${PREFIX}-9-claude`, path: `/srv/karst/${PREFIX}-9-claude`, ticketId: 9 }]);
    expect(ssh.calls.filter((c) => (c.args.at(-1) ?? '').includes('karst-ssh-strays'))).toHaveLength(1);
  });

  it('an unconfirmed remote runs no ssh call and is reported as not confirmed', async () => {
    const ssh = fakeSshProcess();
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: mkdtempSync(join(tmpdir(), 'karst-strays-empty-')), ssh, controlDir: controlDir(), inventory: { sandboxes: [], errors: [] },
    });
    expect(ssh.calls).toEqual([]);
    expect(r.strays).toEqual([]);
    expect(r.errors).toEqual(['ssh devbox: ssh remote devbox not confirmed']);
  });

  it('skips a remote whose inventory listing failed (its dirs are unknown, not stray)', async () => {
    const ssh = fakeSshProcess();
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, controlDir: controlDir(),
      inventory: { sandboxes: [], errors: ['ssh devbox: transport failed: connection refused'] },
    });
    expect(ssh.calls.some((c) => (c.args.at(-1) ?? '').includes('karst-ssh-strays'))).toBe(false);
    expect(r.strays).toEqual([]);
  });

  it('removes a ControlMaster socket only when ssh -O check fails; a live one is kept', async () => {
    const dir = controlDir();
    const dead = join(dir, 'a'.repeat(40));
    const live = join(dir, 'b'.repeat(40));
    writeFileSync(dead, '');
    writeFileSync(live, '');
    const ssh = fakeSshProcess({
      'karst-ssh-strays': { stdout: script([]) },
      [`-O check -o ControlPath=${dead}`]: { code: 1, stderr: 'not a multiplexing master' },
      [`-O check -o ControlPath=${live}`]: { code: 0 },
    });
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, controlDir: dir, inventory: { sandboxes: [], errors: [] },
    });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(r.sockets).toEqual([
      { socket: dead, removed: true },
      { socket: live, removed: false },
    ]);
    expect(describeRemoteStrays(r)).toContain(`karst: removed stale ssh control socket ${dead}`);
  });

  const SOCK_A = 'a'.repeat(40);
  const SOCK_B = 'b'.repeat(40);
  const checkArgv = (socket: string, port: string, dest = 'karst@vm.example.com'): string[] =>
    ['-O', 'check', '-o', `ControlPath=${socket}`, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', port, '--', dest];
  const checkCalls = (ssh: ReturnType<typeof fakeSshProcess>): (readonly string[])[] => ssh.calls.filter((c) => c.args[0] === '-O').map((c) => c.args);
  const none = { sandboxes: [], errors: [] };

  it('runs the stray script once with the exact argv, control dir and output bound', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([]) } });
    const dir = controlDir();
    await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, controlDir: dir, inventory: none, listSockets: async () => [],
    });
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0]!.args).toEqual(sshArgv(DIRECT, dir, remoteStraysScript('/srv/karst')));
    expect(ssh.calls[0]!.opts).toEqual({ maxStdoutBytes: 262144, signal: expect.any(AbortSignal) });
  });

  it('reports a failed sweep with the last non-blank stderr line', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { code: 1, stdout: script([`${PREFIX}-8-codex`]), stderr: 'first\n\nsecond\n  Permission denied  \n' } });
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, controlDir: controlDir(), inventory: none, listSockets: async () => [],
    });
    expect(r).toEqual({ strays: [], sockets: [], errors: ['ssh devbox: stray sweep failed:   Permission denied'] });
  });

  it('reports a transport failure with code 0 and no stderr without a detail', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { code: 0, transport: true, stdout: script([`${PREFIX}-8-codex`]) } });
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, controlDir: controlDir(), inventory: none, listSockets: async () => [],
    });
    expect(r).toEqual({ strays: [], sockets: [], errors: ['ssh devbox: stray sweep failed'] });
  });

  it('does not repeat a not-confirmed reason the inventory already reports', async () => {
    const ssh = fakeSshProcess();
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: mkdtempSync(join(tmpdir(), 'karst-strays-empty-')), ssh, controlDir: controlDir(),
      inventory: { sandboxes: [], errors: ['ssh devbox: ssh remote devbox not confirmed'] }, listSockets: async () => [SOCK_A],
    });
    expect(r).toEqual({ strays: [], sockets: [], errors: [] });
    expect(ssh.calls).toEqual([]);
  });

  it('sweeps a remote even when another runner\'s listing failed; trailing slashes are trimmed from paths', async () => {
    const def: RemoteDef = { ...DOCKER, remoteDir: '/srv/karst//' };
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([`${PREFIX}-8-codex`], ['r3']) } });
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: def }, installId: INSTALL_ID, trustDir: trust(def), ssh, controlDir: controlDir(),
      inventory: { sandboxes: [], errors: ['docker ps failed: y'] }, listSockets: async () => [],
    });
    expect(r).toEqual({
      strays: [
        { kind: 'half-made', remote: 'devbox', name: `${PREFIX}-8-codex`, path: `/srv/karst/${PREFIX}-8-codex` },
        { kind: 'assets', remote: 'devbox', name: 'r3', path: '/srv/karst/.karst-assets/r3' },
      ],
      sockets: [],
      errors: [],
    });
  });

  it('counts only the ssh boxes of this remote as listed', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([`${PREFIX}-8-codex`, `${PREFIX}-9-claude`], [OPENCODE_IMAGE_REVISION]) } });
    const inv = {
      sandboxes: [
        { runner: 'docker' as const, remote: 'devbox', name: `${PREFIX}-8-codex`, ticketId: 8, core: 'codex', state: 'running' as const },
        { runner: 'ssh' as const, remote: 'other', name: `${PREFIX}-9-claude`, ticketId: 9, core: 'claude', state: 'running' as const },
      ],
      errors: [],
    };
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DOCKER }, installId: INSTALL_ID, trustDir: trust(DOCKER), ssh, controlDir: controlDir(), inventory: inv, listSockets: async () => [],
    });
    expect(r.strays).toEqual([
      { kind: 'half-made', remote: 'devbox', name: `${PREFIX}-8-codex`, path: `/srv/karst/${PREFIX}-8-codex` },
      { kind: 'half-made', remote: 'devbox', name: `${PREFIX}-9-claude`, path: `/srv/karst/${PREFIX}-9-claude` },
      { kind: 'assets', remote: 'devbox', name: OPENCODE_IMAGE_REVISION, path: `/srv/karst/.karst-assets/${OPENCODE_IMAGE_REVISION}` },
    ]);
  });

  it('a direct-mode remote with a listed workspace uses no asset revision', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([`${PREFIX}-7-claude`], [OPENCODE_IMAGE_REVISION]) } });
    const inv = { sandboxes: [{ runner: 'ssh' as const, remote: 'devbox', name: `${PREFIX}-7-claude`, ticketId: 7, core: 'claude', state: 'running' as const }], errors: [] };
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, controlDir: controlDir(), inventory: inv, listSockets: async () => [],
    });
    expect(r.strays).toEqual([
      { kind: 'assets', remote: 'devbox', name: OPENCODE_IMAGE_REVISION, path: `/srv/karst/.karst-assets/${OPENCODE_IMAGE_REVISION}` },
    ]);
  });

  it('a forgotten record of an unknown remote keeps its bare name; one with no remote is not a remote stray', async () => {
    const def: RemoteDef = { ...DIRECT, remoteDir: '/srv/karst//' };
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([]) } });
    const inv = {
      sandboxes: [
        { runner: 'ssh' as const, remote: 'gone', name: 'w-1', ticketId: 1, core: 'claude', state: 'stopped' as const, stray: true as const },
        { runner: 'ssh' as const, name: 'w-2', ticketId: 2, core: 'claude', state: 'stopped' as const, stray: true as const },
        { runner: 'ssh' as const, remote: 'devbox', name: 'w-3', ticketId: 3, core: 'claude', state: 'stopped' as const, stray: true as const },
      ],
      errors: [],
    };
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: def }, installId: INSTALL_ID, trustDir: trust(def), ssh, controlDir: controlDir(), inventory: inv, listSockets: async () => [],
    });
    expect(r.strays).toEqual([
      { kind: 'forgotten', remote: 'gone', name: 'w-1', path: 'w-1', ticketId: 1 },
      { kind: 'forgotten', remote: 'devbox', name: 'w-3', path: '/srv/karst/w-3', ticketId: 3 },
    ]);
  });

  it('checks each socket with the exact argv of the first trusted remote and its port', async () => {
    const dir = controlDir();
    const other: RemoteDef = { ...DIRECT, host: 'other.example.com', port: 9 };
    const def: RemoteDef = { ...DIRECT, port: 2222 };
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([]) } });
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { aaa: other, devbox: def }, installId: INSTALL_ID, trustDir: trust(def), ssh, controlDir: dir,
      inventory: { sandboxes: [], errors: ['ssh aaa: ssh remote aaa not confirmed'] }, listSockets: async () => ['not-a-socket', SOCK_A],
    });
    expect(checkCalls(ssh)).toEqual([checkArgv(join(dir, SOCK_A), '2222')]);
    expect(r.sockets).toEqual([{ socket: join(dir, SOCK_A), removed: false }]);
  });

  it('checks a socket on port 22 when the remote names no port', async () => {
    const dir = controlDir();
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([]) } });
    await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, controlDir: dir, inventory: none, listSockets: async () => [SOCK_A],
    });
    expect(checkCalls(ssh)).toEqual([checkArgv(join(dir, SOCK_A), '22')]);
  });

  it('sweeps no socket when no remote is trusted', async () => {
    const ssh = fakeSshProcess();
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: mkdtempSync(join(tmpdir(), 'karst-strays-empty-')), ssh, controlDir: controlDir(),
      inventory: none, listSockets: async () => [SOCK_A],
    });
    expect(r.sockets).toEqual([]);
    expect(ssh.calls).toEqual([]);
  });

  it('reads only connection-hash names of a real control dir, sorted; a missing dir has none', async () => {
    const dir = controlDir();
    writeFileSync(join(dir, SOCK_B), '');
    writeFileSync(join(dir, SOCK_A), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([]) } });
    const deps = { projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, inventory: none };
    const r = await findRemoteStrays({ ...deps, controlDir: dir });
    expect(r.sockets).toEqual([{ socket: join(dir, SOCK_A), removed: false }, { socket: join(dir, SOCK_B), removed: false }]);
    const missing = await findRemoteStrays({ ...deps, controlDir: join(dir, 'missing') });
    expect(missing.sockets).toEqual([]);
  });

  it('checks the listed sockets in sorted order, whatever order the listing gives', async () => {
    const dir = controlDir();
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([]) } });
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, controlDir: dir, inventory: none,
      listSockets: async () => [SOCK_B, SOCK_A],
    });
    expect(r.sockets).toEqual([{ socket: join(dir, SOCK_A), removed: false }, { socket: join(dir, SOCK_B), removed: false }]);
  });

  it('reports a socket it could not remove with the reason', async () => {
    const dir = controlDir();
    const ssh = fakeSshProcess({ 'karst-ssh-strays': { stdout: script([]) }, '-O check': { code: 1 } });
    const r = await findRemoteStrays({
      projectRoot: '/p', remotes: { devbox: DIRECT }, installId: INSTALL_ID, trustDir: trust(), ssh, controlDir: dir, inventory: none,
      listSockets: async () => [SOCK_A, SOCK_B],
      unlink: async (p) => { if (p.endsWith(SOCK_A)) throw new Error('EPERM'); throw 'busy'; },
    });
    expect(r.sockets).toEqual([
      { socket: join(dir, SOCK_A), removed: false, reason: 'EPERM' },
      { socket: join(dir, SOCK_B), removed: false, reason: 'busy' },
    ]);
  });
});

describe('remoteStraysScript / parseRemoteStrays', () => {
  it('builds the exact listing script with the trailing slashes trimmed', () => {
    expect(remoteStraysScript('/srv/karst//')).toBe([
      '# karst-ssh-strays',
      String.raw`printf '%s\n' '__KARST_STRAY_DIRS__'`,
      `ls -1 '/srv/karst' 2>/dev/null`,
      String.raw`printf '%s\n' '__KARST_STRAY_ASSETS__'`,
      `ls -1 '/srv/karst'/.karst-assets 2>/dev/null`,
      'exit 0',
    ].join('\n'));
  });

  it('trims names and drops blank, . and .. lines', () => {
    expect(parseRemoteStrays('__KARST_STRAY_DIRS__\n  d1  \n.\n..\n\nd2\n__KARST_STRAY_ASSETS__\n r1 \n.\n')).toEqual({ dirs: ['d1', 'd2'], assets: ['r1'] });
  });

  it('reads the dirs to the end when the assets marker is missing', () => {
    expect(parseRemoteStrays('__KARST_STRAY_DIRS__\nd1\nd2')).toEqual({ dirs: ['d1', 'd2'], assets: [] });
  });

  it('reads no dirs when the dirs marker is missing', () => {
    expect(parseRemoteStrays('some banner text here\n__KARST_STRAY_ASSETS__\nr1')).toEqual({ dirs: [], assets: ['r1'] });
  });

  it('an assets marker at the very start ends the dirs part there', () => {
    expect(parseRemoteStrays('__KARST_STRAY_ASSETS__\nr1\n__KARST_STRAY_DIRS__\nd1')).toEqual({ dirs: [], assets: ['r1', '__KARST_STRAY_DIRS__', 'd1'] });
  });
});

describe('describeRemoteStrays', () => {
  it('writes one exact line per error, stray and socket outcome', () => {
    expect(describeRemoteStrays({
      errors: ['ssh devbox: stray sweep failed'],
      strays: [
        { kind: 'half-made', remote: 'devbox', name: 'w', path: '/srv/w' },
        { kind: 'assets', remote: 'devbox', name: 'r3', path: '/srv/.karst-assets/r3' },
        { kind: 'forgotten', remote: 'box2', name: 'f', path: '/srv/f', ticketId: 4 },
      ],
      sockets: [
        { socket: '/c/1', removed: true },
        { socket: '/c/2', removed: false },
        { socket: '/c/3', removed: false, reason: 'EPERM' },
      ],
    })).toEqual([
      'karst: ssh devbox: stray sweep failed',
      'karst: ssh devbox: half-made remote workspace /srv/w',
      'karst: ssh devbox: unused remote assets /srv/.karst-assets/r3',
      'karst: ssh box2: forgotten remote workspace /srv/f (delete it from the ticket)',
      'karst: removed stale ssh control socket /c/1',
      'karst: could not remove stale ssh control socket /c/3: EPERM',
    ]);
  });
});
