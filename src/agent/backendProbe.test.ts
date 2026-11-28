import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerKillContext, probeDockerDisk, probeDockerImageDisk, probeDockerMemory, probeRemoteDisk, probeRemoteWorkspaces, type RemoteProbeContext } from './backendProbe.js';
import type { SbxProcess } from './sbx/sbxProcess.js';
import { fakeSshProcess } from './ssh/fakeSshProcess.js';
import { remoteTrustKey } from './ssh/remoteTrust.js';
import { sshProjectPrefix } from './ssh/sshNames.js';
import type { RemoteDef } from '../manifest/types.js';

const REMOTE: RemoteDef = { host: 'devbox.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const INSTALL_ID = 'a'.repeat(32);
const NAME = `${sshProjectPrefix('/proj/karst.yml', INSTALL_ID)}-7-claude`;

function trustedDir(def: RemoteDef = REMOTE, name = 'devbox'): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-remote-probe-'));
  writeFileSync(join(dir, 'ssh-trust.json'), JSON.stringify({ [name]: remoteTrustKey(name, def) }));
  return dir;
}

function ctx(dir: string, now = Date.UTC(2026, 10, 28)): RemoteProbeContext {
  return { projectRoot: '/proj/karst.yml', installId: INSTALL_ID, trustDir: dir, controlDir: '/tmp/karst-ssh-1', now };
}

describe('probeRemoteDisk', () => {
  it('reads the workspace count, the prefix size and the free disk in one ssh call', async () => {
    const dir = trustedDir();
    const ssh = fakeSshProcess({ '# karst-ssh-remote-disk': { stdout: 'count=2\nusedKb=1024\nfreeKb=51200\n' } });
    try {
      expect(await probeRemoteDisk(ssh, 'devbox', REMOTE, ctx(dir))).toEqual({ workspaces: 2, usedKb: 1024, freeKb: 51200 });
      expect(ssh.calls).toHaveLength(1);
      expect(ssh.calls[0]!.args.at(-1)).toContain('df -Pk');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unconfirmed remote gets no ssh call at all', async () => {
    const dir = trustedDir();
    const other: RemoteDef = { ...REMOTE, host: 'changed.example.com' };
    const ssh = fakeSshProcess({ '# karst-ssh-remote-disk': { stdout: 'count=99\nusedKb=1\nfreeKb=1\n' } });
    try {
      expect(await probeRemoteDisk(ssh, 'devbox', other, ctx(dir))).toEqual({ error: 'ssh devbox: ssh remote devbox not confirmed' });
      expect(ssh.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a transport failure per remote', async () => {
    const dir = trustedDir();
    const ssh = fakeSshProcess({ '# karst-ssh-remote-disk': { transport: true, code: 255, stderr: 'boom' } });
    try {
      expect(await probeRemoteDisk(ssh, 'devbox', REMOTE, ctx(dir))).toEqual({ error: 'ssh devbox: transport failed: boom' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('probeRemoteWorkspaces', () => {
  it('reads env.sh age and du per prefix workspace, and skips anything else', async () => {
    const dir = trustedDir();
    const now = Date.UTC(2026, 10, 28);
    const fifteenDays = Math.floor(now / 1000) - 15 * 86_400;
    const ssh = fakeSshProcess({
      '# karst-ssh-remote-workspaces': { stdout: `${NAME}\t${String(fifteenDays)}\t2048\n` },
    });
    try {
      expect(await probeRemoteWorkspaces(ssh, 'devbox', REMOTE, ctx(dir, now))).toEqual([
        { name: NAME, ageDays: 15, sizeKb: 2048 },
      ]);
      expect(ssh.calls).toHaveLength(1);
      expect(ssh.calls[0]!.args.at(-1)).toContain('env/env.sh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unconfirmed remote gets no ssh call', async () => {
    const dir = trustedDir();
    const ssh = fakeSshProcess({ '# karst-ssh-remote-workspaces': { stdout: `${NAME}\t0\t1\n` } });
    try {
      const out = await probeRemoteWorkspaces(ssh, 'devbox', { ...REMOTE, mode: 'docker' }, ctx(dir));
      expect('error' in out && out.error).toBe('ssh devbox: ssh remote devbox not confirmed');
      expect(ssh.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const proc = (code: number, stdout: string): SbxProcess => ({ run: async () => ({ code, stdout, stderr: '' }) });

describe('probeDockerDisk', () => {
  it('sums the container sizes', async () => {
    expect(await probeDockerDisk(proc(0, '1GB (virtual 2GB)\n500MB (virtual 1GB)\n'))).toBeCloseTo(1.5e9, -3);
  });
  it('is 0 with no containers', async () => {
    expect(await probeDockerDisk(proc(0, ''))).toBe(0);
  });
  it('is undefined when docker fails', async () => {
    expect(await probeDockerDisk(proc(1, ''))).toBeUndefined();
  });
  it('is undefined on unparseable output', async () => {
    expect(await probeDockerDisk(proc(0, 'weird\n'))).toBeUndefined();
  });
  it('is undefined when the process throws', async () => {
    expect(await probeDockerDisk({ run: async () => { throw new Error('x'); } })).toBeUndefined();
  });
});

describe('probeDockerMemory', () => {
  it('reads the MemTotal bytes', async () => {
    expect(await probeDockerMemory(proc(0, '5154000000\n'))).toBe(5154000000);
  });
  it('asks docker info for MemTotal', async () => {
    const calls: string[][] = [];
    await probeDockerMemory({ run: async (c, a) => { calls.push([c, ...a]); return { code: 0, stdout: '1', stderr: '' }; } });
    expect(calls).toEqual([['docker', 'info', '--format', '{{.MemTotal}}']]);
  });
  it.each([[1, '5'], [0, ''], [0, 'abc'], [0, '0'], [0, '-4']])('is undefined for code %i stdout %j', async (code, out) => {
    expect(await probeDockerMemory(proc(code, out))).toBeUndefined();
  });
  it('is undefined when the process throws', async () => {
    expect(await probeDockerMemory({ run: async () => { throw new Error('x'); } })).toBeUndefined();
  });
});

describe('dockerKillContext', () => {
  const GB = 2 ** 30;
  const multi = (info: { code: number; stdout: string }, ps: { code: number; stdout: string } | 'throw'): SbxProcess => ({
    run: async (_c, a) => {
      if (a[0] === 'info') return { ...info, stderr: '' };
      if (ps === 'throw') throw new Error('x');
      return { ...ps, stderr: '' };
    },
  });
  it('names the VM memory and counts karst/playwright containers', async () => {
    const ps = { code: 0, stdout: 'karst-a img\nweb nginx\nrunner mcr.microsoft.com/Playwright:v1\n' };
    expect(await dockerKillContext(multi({ code: 0, stdout: String(4.8 * GB) }, ps))).toBe('Docker VM 4.8 GB, 2 karst/playwright containers running');
  });
  it('singular for one container', async () => {
    expect(await dockerKillContext(multi({ code: 0, stdout: String(8 * GB) }, { code: 0, stdout: 'karst-a img\n' }))).toBe('Docker VM 8.0 GB, 1 karst/playwright container running');
  });
  it('zero containers is still reported', async () => {
    expect(await dockerKillContext(multi({ code: 0, stdout: String(8 * GB) }, { code: 0, stdout: '' }))).toBe('Docker VM 8.0 GB, 0 karst/playwright containers running');
  });
  it('drops the container part when ps fails or throws', async () => {
    expect(await dockerKillContext(multi({ code: 0, stdout: String(8 * GB) }, { code: 1, stdout: '' }))).toBe('Docker VM 8.0 GB');
    expect(await dockerKillContext(multi({ code: 0, stdout: String(8 * GB) }, 'throw'))).toBe('Docker VM 8.0 GB');
  });
  it('drops the memory part when info fails', async () => {
    expect(await dockerKillContext(multi({ code: 1, stdout: '' }, { code: 0, stdout: 'karst-a x\n' }))).toBe('1 karst/playwright container running');
  });
  it('is undefined when nothing is readable', async () => {
    expect(await dockerKillContext(multi({ code: 1, stdout: '' }, { code: 1, stdout: '' }))).toBeUndefined();
  });
});

describe('probeDockerImageDisk', () => {
  it('sums karst image sizes and reads the build cache row', async () => {
    const run = async (_c: string, a: readonly string[]) =>
      a[0] === 'image'
        ? { code: 0, stdout: '2GB\n500MB\n', stderr: '' }
        : { code: 0, stdout: 'Images|36GB\nBuild Cache|50GB\n', stderr: '' };
    const r = await probeDockerImageDisk({ run });
    expect(r.imageBytes).toBeCloseTo(2.5e9, -3);
    expect(r.cacheBytes).toBeCloseTo(50e9, -3);
  });
  it('is undefined per probe on failure, bad output or throw', async () => {
    expect(await probeDockerImageDisk(proc(1, ''))).toEqual({ imageBytes: undefined, cacheBytes: undefined });
    expect(await probeDockerImageDisk(proc(0, 'weird\n'))).toEqual({ imageBytes: undefined, cacheBytes: 0 });
    expect(await probeDockerImageDisk({ run: async () => { throw new Error('x'); } })).toEqual({ imageBytes: undefined, cacheBytes: undefined });
  });
});
