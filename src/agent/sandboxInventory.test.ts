import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../manifest/types.js';
import { fakeSbxProcess } from './sbx/fakeSbxProcess.js';
import { sbxName } from './sbx/sbxName.js';
import { listProjectSandboxes, parseSandboxName } from './sandboxInventory.js';
import { fakeSshProcess } from './ssh/fakeSshProcess.js';
import { REMOTE_TRUST_FILE, remoteTrustKey } from './ssh/remoteTrust.js';
import { sshProjectPrefix } from './ssh/sshNames.js';
import { SSH_STRAYS_FILE } from './ssh/sshStrays.js';

const ROOT = '/p/karst.yml';
const own = (id: number, core: string): string => sbxName({ projectRoot: ROOT, ticketId: id, core });
const foreign = sbxName({ projectRoot: '/other/karst.yml', ticketId: 7, core: 'claude' });

describe('parseSandboxName', () => {
  it('parses this project names back to ticket and core', () => {
    expect(parseSandboxName(own(7, 'claude'), ROOT)).toEqual({ ticketId: 7, core: 'claude' });
    expect(parseSandboxName(own(12, 'opencode2'), ROOT)).toEqual({ ticketId: 12, core: 'opencode2' });
  });
  it('ignores other projects, sidecars and unknown cores', () => {
    expect(parseSandboxName(foreign, ROOT)).toBeUndefined();
    expect(parseSandboxName(`${own(7, 'opencode')}-proxy`, ROOT)).toBeUndefined();
    expect(parseSandboxName(own(7, 'claude').replace(/claude$/, 'unknown'), ROOT)).toBeUndefined();
    expect(parseSandboxName('karst-zz', ROOT)).toBeUndefined();
    for (const suffix of ['-repo', '-data', '-net']) expect(parseSandboxName(`${own(7, 'opencode2')}${suffix}`, ROOT)).toBeUndefined();
  });
});

describe('listProjectSandboxes invalid cores (F6)', () => {
  it('reports a project sandbox named for a wrong core as an invalid-core orphan, not as a ticket sandbox', async () => {
    const bad = own(7, 'claude').replace(/claude$/, 'null');
    const docker = fakeSbxProcess({ 'docker ps': { stdout: `${bad}\trunning\n${own(7, 'opencode')}\texited\n${own(7, 'opencode')}-proxy\trunning\n` } });
    const inv = await listProjectSandboxes({ projectRoot: ROOT, sbx: fakeSbxProcess(), docker });
    expect(inv.sandboxes).toEqual([
      { runner: 'docker', name: bad, ticketId: 7, core: 'null', state: 'running', invalidCore: true },
      { runner: 'docker', name: own(7, 'opencode'), ticketId: 7, core: 'opencode', state: 'stopped' },
    ]);
  });
});

describe('listProjectSandboxes', () => {
  it('lists both runners with state, own project only', async () => {
    const sbx = fakeSbxProcess({
      'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${own(7, 'claude')} claude running\n${foreign} claude running\n${own(8, 'codex')} codex stopped\n` },
    });
    const docker = fakeSbxProcess({
      'docker ps': { stdout: `${own(9, 'opencode')}\trunning\n${own(9, 'opencode')}-proxy\trunning\n${own(10, 'opencode2')}\texited\n` },
    });
    const r = await listProjectSandboxes({ projectRoot: ROOT, sbx, docker });
    expect(r.errors).toEqual([]);
    expect(r.sandboxes).toEqual([
      { runner: 'sbx', name: own(7, 'claude'), ticketId: 7, core: 'claude', state: 'running' },
      { runner: 'sbx', name: own(8, 'codex'), ticketId: 8, core: 'codex', state: 'stopped' },
      { runner: 'docker', name: own(9, 'opencode'), ticketId: 9, core: 'opencode', state: 'running' },
      { runner: 'docker', name: own(10, 'opencode2'), ticketId: 10, core: 'opencode2', state: 'stopped' },
    ]);
    expect(docker.calls[0]!.args).toEqual(['ps', '-a', '--filter', `name=${own(9, 'opencode').split('-').slice(0, 2).join('-')}-`, '--format', '{{.Names}}\t{{.State}}']);
  });
  it('reads the machine listing: a `● running` table row is running, not stopped', async () => {
    const sbx = fakeSbxProcess({
      'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${own(7, 'claude')} claude ● running\n${own(8, 'codex')} codex ● stopped\n` },
    });
    const r = await listProjectSandboxes({ projectRoot: ROOT, sbx, docker: fakeSbxProcess() });
    expect(r.sandboxes).toEqual([
      { runner: 'sbx', name: own(7, 'claude'), ticketId: 7, core: 'claude', state: 'running' },
      { runner: 'sbx', name: own(8, 'codex'), ticketId: 8, core: 'codex', state: 'stopped' },
    ]);
  });
  it('prefers `sbx ls --json` (name + status) over the human table', async () => {
    const sbx = fakeSbxProcess({
      'sbx ls --json': { stdout: JSON.stringify([{ name: own(7, 'claude'), status: 'running' }, { name: own(8, 'codex'), status: 'stopped' }, { name: foreign, status: 'running' }]) },
    });
    const r = await listProjectSandboxes({ projectRoot: ROOT, sbx, docker: fakeSbxProcess() });
    expect(sbx.calls[0]!.args).toEqual(['ls', '--json']);
    expect(r.sandboxes).toEqual([
      { runner: 'sbx', name: own(7, 'claude'), ticketId: 7, core: 'claude', state: 'running' },
      { runner: 'sbx', name: own(8, 'codex'), ticketId: 8, core: 'codex', state: 'stopped' },
    ]);
  });
  it('falls back to the table when --json is unsupported', async () => {
    const sbx = fakeSbxProcess({
      'sbx ls --json': { code: 2, stderr: 'unknown flag: --json' },
      'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${own(7, 'claude')} claude ● running\n` },
    });
    const r = await listProjectSandboxes({ projectRoot: ROOT, sbx, docker: fakeSbxProcess() });
    expect(r.errors).toEqual([]);
    expect(r.sandboxes).toEqual([{ runner: 'sbx', name: own(7, 'claude'), ticketId: 7, core: 'claude', state: 'running' }]);
    expect(sbx.calls.map((c) => c.args.join(' '))).toEqual(['ls --json', 'ls']);
  });
  it('reports a failing tool instead of throwing, keeps the other', async () => {
    const sbx = fakeSbxProcess({ 'sbx ls': { code: 127, stderr: 'not found' } });
    const docker = fakeSbxProcess({ 'docker ps': { stdout: `${own(9, 'opencode')}\trunning\n` } });
    const r = await listProjectSandboxes({ projectRoot: ROOT, sbx, docker });
    expect(r.errors).toEqual(['sbx ls failed: not found']);
    expect(r.sandboxes.map((s) => s.ticketId)).toEqual([9]);
  });
});

describe('listProjectSandboxes docker -repo volumes', () => {
  const run = (docker: ReturnType<typeof fakeSbxProcess>) =>
    listProjectSandboxes({ projectRoot: ROOT, sbx: fakeSbxProcess({ 'sbx ls': { stdout: '' } }), docker });

  it('lists a docker sandbox from its -repo volume when its agent container is gone', async () => {
    const n = own(7, 'opencode2');
    const docker = fakeSbxProcess({ 'docker ps': { stdout: `${n}-proxy\trunning\n` }, 'docker volume ls': { stdout: `${n}-repo\n${n}-data\n` } });
    const inv = await run(docker);
    expect(inv.sandboxes).toEqual([{ runner: 'docker', name: n, ticketId: 7, core: 'opencode2', state: 'stopped' }]);
    const vol = docker.calls.find((c) => c.args[0] === 'volume');
    expect(vol?.args).toEqual(['volume', 'ls', '--filter', `name=${n.split('-').slice(0, 2).join('-')}-`, '--format', '{{.Name}}']);
  });
  it('a container entry wins over its -repo volume', async () => {
    const n = own(9, 'opencode');
    const inv = await run(fakeSbxProcess({ 'docker ps': { stdout: `${n}\trunning\n` }, 'docker volume ls': { stdout: `${n}-repo\n` } }));
    expect(inv.sandboxes.filter((s) => s.ticketId === 9)).toEqual([{ runner: 'docker', name: n, ticketId: 9, core: 'opencode', state: 'running' }]);
  });
  it('a -data volume alone, or another project volume, is not a sandbox', async () => {
    const other = sbxName({ projectRoot: '/other/karst.yml', ticketId: 6, core: 'opencode' });
    const inv = await run(fakeSbxProcess({ 'docker ps': { stdout: '' }, 'docker volume ls': { stdout: `${own(5, 'opencode')}-data\n${other}-repo\n` } }));
    expect(inv.sandboxes).toEqual([]);
  });
  it('a -repo volume named for a core docker cannot host is an invalid-core orphan', async () => {
    const inv = await run(fakeSbxProcess({ 'docker volume ls': { stdout: `${own(4, 'claude')}-repo\n` } }));
    expect(inv.sandboxes).toEqual([{ runner: 'docker', name: own(4, 'claude'), ticketId: 4, core: 'claude', state: 'stopped', invalidCore: true }]);
  });
  it('a failing volume listing is reported, the containers stay', async () => {
    const inv = await run(fakeSbxProcess({ 'docker ps': { stdout: `${own(9, 'opencode')}\trunning\n` }, 'docker volume ls': { code: 1, stderr: 'boom\n' } }));
    expect(inv.sandboxes.map((s) => s.ticketId)).toEqual([9]);
    expect(inv.errors).toContain('docker volume ls failed: boom');
  });
  it('a failing docker ps skips the volume listing', async () => {
    const docker = fakeSbxProcess({ 'docker ps': { code: 1, stderr: 'daemon down' } });
    const inv = await run(docker);
    expect(docker.calls.some((c) => c.args[0] === 'volume')).toBe(false);
    expect(inv.errors.some((e) => e.startsWith('docker ps failed'))).toBe(true);
  });
});

describe('listProjectSandboxes ssh remotes (D824, edit 1)', () => {
  const INSTALL = '0123456789abcdef0123456789abcdef';
  const OTHER_INSTALL = 'ffffffffffffffffffffffffffffffff';
  const PREFIX = sshProjectPrefix(ROOT, INSTALL);
  const sshName = (id: number, core: string): string => `${PREFIX}-${String(id)}-${core}`;
  const DEVBOX: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
  const BROKEN: RemoteDef = { ...DEVBOX, host: 'broken.example.com', remoteDir: '/srv/broken' };

  function trustDir(entries: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'karst-inv-'));
    writeFileSync(join(dir, REMOTE_TRUST_FILE), JSON.stringify(entries));
    return dir;
  }
  const trusted = (name: string, def: RemoteDef): Record<string, string> => ({ [name]: remoteTrustKey(name, def) });
  const remoteList = (names: readonly string[], running: readonly string[] = names): string =>
    ['__KARST_DIRS__', ...names, '__KARST_TMUX__', ...running].join('\n');
  const base = { projectRoot: ROOT, sbx: fakeSbxProcess(), docker: fakeSbxProcess() };

  it('lists this install\'s workspace per remote with its tmux status; other installs and projects never match', async () => {
    const otherInstall = sshProjectPrefix(ROOT, OTHER_INSTALL);
    const otherProject = sshProjectPrefix('/other/karst.yml', INSTALL);
    const ssh = fakeSshProcess({ [DEVBOX.remoteDir]: { stdout: remoteList([
      sshName(7, 'claude'),
      sshName(8, 'codex'),
      `${otherInstall}-9-claude`,
      `${otherProject}-10-claude`,
      `${PREFIX}-agy`, // not an SSH core
      'karst-not-a-name',
    ], [sshName(7, 'claude')]) } });
    const inv = await listProjectSandboxes({
      ...base, remotes: { devbox: DEVBOX }, ssh, installId: INSTALL, trustDir: trustDir(trusted('devbox', DEVBOX)),
    });
    expect(inv.errors).toEqual([]);
    expect(inv.sandboxes).toEqual([
      { runner: 'ssh', name: sshName(7, 'claude'), remote: 'devbox', ticketId: 7, core: 'claude', state: 'running' },
      { runner: 'ssh', name: sshName(8, 'codex'), remote: 'devbox', ticketId: 8, core: 'codex', state: 'stopped' },
    ]);
  });

  it('two remotes: one failure is reported for that remote only and never hides the other or the local backends', async () => {
    const ssh = fakeSshProcess({
      [DEVBOX.remoteDir]: { stdout: remoteList([sshName(7, 'claude')]) },
      [BROKEN.remoteDir]: { code: 255, transport: true, stderr: 'ssh: connect to host broken port 22: Connection refused' },
    });
    const local = sbxName({ projectRoot: ROOT, ticketId: 5, core: 'claude' });
    const inv = await listProjectSandboxes({
      ...base,
      sbx: fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${local} claude running\n` } }),
      remotes: { devbox: DEVBOX, broken: BROKEN }, ssh, installId: INSTALL,
      trustDir: trustDir({ ...trusted('devbox', DEVBOX), ...trusted('broken', BROKEN) }),
    });
    expect(inv.errors).toEqual(['ssh broken: transport failed: ssh: connect to host broken port 22: Connection refused']);
    expect(inv.sandboxes.map((s) => [s.runner, s.ticketId])).toEqual([['sbx', 5], ['ssh', 7]]);
  });

  it('an unconfirmed remote gets ZERO ssh calls and a `not confirmed` error', async () => {
    const ssh = fakeSshProcess();
    const inv = await listProjectSandboxes({
      ...base, remotes: { devbox: DEVBOX }, ssh, installId: INSTALL, trustDir: trustDir({}),
    });
    expect(ssh.calls).toEqual([]);
    expect(inv.errors).toEqual(['ssh devbox: ssh remote devbox not confirmed']);
    expect(inv.sandboxes).toEqual([]);
  });

  it('a missing install id lists no ssh remote and makes no ssh call', async () => {
    const ssh = fakeSshProcess();
    const inv = await listProjectSandboxes({
      ...base, remotes: { devbox: DEVBOX }, ssh, trustDir: trustDir(trusted('devbox', DEVBOX)),
    });
    expect(ssh.calls).toEqual([]);
    expect(inv.errors).toEqual(['ssh devbox: install id missing']);
  });

  it('mode docker reuses the docker listing through the ssh seam, filtered by the SSH prefix', async () => {
    const dockerRemote: RemoteDef = { ...DEVBOX, mode: 'docker' };
    const ssh = fakeSshProcess({
      '{{.Names}}': { stdout: `${sshName(7, 'opencode')}\trunning\n` },
      volume: { stdout: `${sshName(8, 'opencode2')}-repo\n` },
    });
    const inv = await listProjectSandboxes({
      ...base, remotes: { devbox: dockerRemote }, ssh, installId: INSTALL,
      trustDir: trustDir(trusted('devbox', dockerRemote)),
    });
    expect(inv.errors).toEqual([]);
    expect(inv.sandboxes).toEqual([
      { runner: 'ssh', name: sshName(7, 'opencode'), remote: 'devbox', ticketId: 7, core: 'opencode', state: 'running' },
      { runner: 'ssh', name: sshName(8, 'opencode2'), remote: 'devbox', ticketId: 8, core: 'opencode2', state: 'stopped' },
    ]);
    // The remote filter uses the ssh prefix (which carries the install id), not the local project prefix.
    expect(ssh.calls[0]!.args.at(-1)).toContain(`name=${PREFIX}-`);
  });

  it('a listed dir with an open stray record is marked stray; the others are not', async () => {
    const dir = trustDir(trusted('devbox', DEVBOX));
    const forgotten = sshName(7, 'claude');
    writeFileSync(join(dir, SSH_STRAYS_FILE), JSON.stringify([
      { remote: 'devbox', path: `${DEVBOX.remoteDir}/${forgotten}`, ticketId: 7, forgottenAt: '2026-01-02T03:04:05.000Z' },
    ]));
    const ssh = fakeSshProcess({ [DEVBOX.remoteDir]: { stdout: remoteList([forgotten, sshName(8, 'codex')]) } });
    const inv = await listProjectSandboxes({ ...base, remotes: { devbox: DEVBOX }, ssh, installId: INSTALL, trustDir: dir });
    expect(inv.sandboxes).toEqual([
      { runner: 'ssh', name: forgotten, remote: 'devbox', ticketId: 7, core: 'claude', state: 'running', stray: true },
      { runner: 'ssh', name: sshName(8, 'codex'), remote: 'devbox', ticketId: 8, core: 'codex', state: 'running' },
    ]);
  });

  it('no remotes keeps the local listing byte-identical (no ssh call)', async () => {
    const ssh = fakeSshProcess();
    const inv = await listProjectSandboxes({ ...base, ssh });
    expect(ssh.calls).toEqual([]);
    expect(inv).toEqual({ sandboxes: [], errors: [] });
  });
});
