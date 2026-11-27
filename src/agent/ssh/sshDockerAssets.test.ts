import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import type { SshResult } from './sshProcess.js';
import { fakeSshProcess } from './fakeSshProcess.js';
import { PROXY_BUNDLE, ensureRemoteDockerAssets, remoteAssetsDir } from './sshDockerAssets.js';

const REMOTE: RemoteDef = { host: 'fake.example.com', user: 'karst', mode: 'docker', remoteDir: '/srv/karst' };
const CONTROL = '/tmp/karst-ssh-0/';
const DEST = remoteAssetsDir('/srv/karst');
const PROBE = 'karst-ssh-docker-assets';

const PROXY_BODY = 'export const proxy = 1;\n';
const DOCKERFILE_BODY = 'FROM node:22\n';

type Ssh = ReturnType<typeof fakeSshProcess>;

const sha = (body: string): string => createHash('sha256').update(body).digest('hex');
const hashLines = (proxy: string, dockerfile: string): string => `${PROXY_BUNDLE}=${proxy}\nDockerfile=${dockerfile}\n`;

/** Decode the ONE quoting layer of `sshArgv` (`sh -c '<script>'`). */
function scriptOf(args: readonly string[]): string {
  return (args.at(-1) ?? '').replace(/^sh -c '/s, '').replace(/'$/s, '').split(`'\\''`).join("'");
}

const created: string[] = [];

async function hostDir(files: Record<string, string> = { [PROXY_BUNDLE]: PROXY_BODY, Dockerfile: DOCKERFILE_BODY }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'karst-docker-assets-'));
  created.push(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function input(ssh: Ssh, hostAssetsDir: string, over: Partial<Parameters<typeof ensureRemoteDockerAssets>[0]> = {}) {
  return {
    ssh, sshBin: 'fake-ssh', remote: REMOTE, remoteName: 'devbox', controlDir: CONTROL, hostAssetsDir, ...over,
  };
}

/** A fake whose probe answers can DIFFER per call (probe, then the post-upload verify). */
function queuedSsh(answers: Record<string, { readonly code?: number; readonly stdout?: string }[]>): Ssh {
  const ssh = fakeSshProcess();
  const seen = new Map<string, number>();
  ssh.run = (args, opts) => {
    ssh.calls.push({ args: [...args], ...(opts ? { opts } : {}) });
    const remote = args.at(-1) ?? '';
    const key = Object.keys(answers).filter((k) => remote.includes(k)).sort((a, b) => b.length - a.length)[0];
    const list = key === undefined ? [{ code: 0, stdout: '' }] : answers[key]!;
    const index = seen.get(key ?? '') ?? 0;
    seen.set(key ?? '', index + 1);
    const answer = list[Math.min(index, list.length - 1)]!;
    const stdout = answer.stdout ?? '';
    const result: SshResult = { code: answer.code ?? 0, stdout, stdoutBuffer: Buffer.from(stdout), stderr: '' };
    return Promise.resolve(result);
  };
  return ssh;
}

describe('remoteAssetsDir', () => {
  it('names the revision dir under remoteDir, tolerating a trailing slash', () => {
    expect(remoteAssetsDir('/srv/karst')).toBe('/srv/karst/.karst-assets/r4');
    expect(remoteAssetsDir('/srv/karst/')).toBe('/srv/karst/.karst-assets/r4');
    expect(remoteAssetsDir('/srv/karst', 'r9')).toBe('/srv/karst/.karst-assets/r9');
  });

  it('refuses a revision that could escape the assets dir', () => {
    expect(() => remoteAssetsDir('/srv/karst', '../x')).toThrow('ssh docker: invalid asset revision "../x"');
  });
});

describe('ensureRemoteDockerAssets', () => {
  it('skips the upload when every remote checksum already matches (one ssh round trip)', async () => {
    const dir = await hostDir();
    const ssh = queuedSsh({ [PROBE]: [{ stdout: hashLines(sha(PROXY_BODY), sha(DOCKERFILE_BODY)) }] });
    await expect(ensureRemoteDockerAssets(input(ssh, dir))).resolves.toEqual({ ok: true });
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.pipes).toHaveLength(0);
    expect(scriptOf(ssh.calls[0]!.args)).toContain(`d='${DEST}'`);
  });

  it('uploads the bundle with a tar pipe and verifies every sha256 on the first run', async () => {
    const dir = await hostDir();
    const ssh = queuedSsh({ [PROBE]: [{ stdout: '' }, { stdout: hashLines(sha(PROXY_BODY), sha(DOCKERFILE_BODY)) }] });
    await expect(ensureRemoteDockerAssets(input(ssh, dir))).resolves.toEqual({ ok: true });
    expect(ssh.pipes).toHaveLength(1);
    const { from, to } = ssh.pipes[0]!;
    expect(from).toEqual({ command: 'tar', args: ['-c', '-C', dir, '.'] });
    expect(to.command).toBe('fake-ssh');
    expect(scriptOf(to.args)).toBe(`mkdir -p -m 700 '${DEST}' && tar -x -C '${DEST}'`);
    // One probe, then the verifying read.
    expect(ssh.calls).toHaveLength(2);
  });

  it('fails closed on a checksum mismatch after the upload (a wrong bundle would disable the allowlist)', async () => {
    const dir = await hostDir();
    const ssh = queuedSsh({ [PROBE]: [{ stdout: '' }, { stdout: hashLines('deadbeef', sha(DOCKERFILE_BODY)) }] });
    await expect(ensureRemoteDockerAssets(input(ssh, dir))).resolves.toEqual({
      ok: false, reason: `ssh devbox: remote asset checksum mismatch for ${PROXY_BUNDLE}`,
    });
  });

  it('fails closed when a file is missing on the remote after the upload', async () => {
    const dir = await hostDir();
    const ssh = queuedSsh({ [PROBE]: [{ stdout: '' }, { stdout: hashLines(sha(PROXY_BODY), '') }] });
    await expect(ensureRemoteDockerAssets(input(ssh, dir))).resolves.toEqual({
      ok: false, reason: 'ssh devbox: remote asset checksum mismatch for Dockerfile',
    });
  });

  it('fails closed on a failed tar, a failed remote extract and a transport drop', async () => {
    const dir = await hostDir();
    const tar = fakeSshProcess({}, { fromCode: 2, toCode: 0 });
    await expect(ensureRemoteDockerAssets(input(tar, dir))).resolves.toEqual({
      ok: false, reason: 'ssh devbox: tar of the docker assets failed (exit 2)',
    });
    const extract = fakeSshProcess({}, { fromCode: 0, toCode: 1 });
    await expect(ensureRemoteDockerAssets(input(extract, dir))).resolves.toEqual({
      ok: false, reason: 'ssh devbox: docker asset upload failed (exit 1)',
    });
    const dropped = fakeSshProcess({}, { fromCode: 0, toCode: 255 });
    await expect(ensureRemoteDockerAssets(input(dropped, dir))).resolves.toEqual({
      ok: false, reason: 'ssh devbox: transport failed during the docker asset upload',
    });
  });

  it('fails closed before any ssh call when the host dir is empty, has no proxy bundle, or cannot be read', async () => {
    const empty = await hostDir({});
    const emptySsh = fakeSshProcess();
    await expect(ensureRemoteDockerAssets(input(emptySsh, empty))).resolves.toMatchObject({ ok: false });
    expect(emptySsh.calls).toHaveLength(0);

    const noProxy = await hostDir({ Dockerfile: DOCKERFILE_BODY });
    const noProxySsh = fakeSshProcess();
    await expect(ensureRemoteDockerAssets(input(noProxySsh, noProxy))).resolves.toEqual({
      ok: false, reason: `ssh devbox: ${noProxy} has no ${PROXY_BUNDLE}`,
    });
    expect(noProxySsh.calls).toHaveLength(0);

    const missingSsh = fakeSshProcess();
    await expect(ensureRemoteDockerAssets(input(missingSsh, join(tmpdir(), 'karst-no-such-assets-dir')))).resolves.toMatchObject({
      ok: false, reason: expect.stringContaining('cannot read the docker assets dir'),
    });
    expect(missingSsh.calls).toHaveLength(0);
  });
});
