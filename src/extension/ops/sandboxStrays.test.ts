import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { fakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { REMOTE_TRUST_FILE, remoteTrustKey } from '../../agent/ssh/remoteTrust.js';
import { sshProjectPrefix } from '../../agent/ssh/sshNames.js';
import { describeRemoteStrays, findRemoteStrays, findStrays, removeStrays } from './sandboxStrays.js';
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
});
