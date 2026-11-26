import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { NODE_SBX_PROCESS } from '../sbx/sbxProcess.js';
import { makeFakeSshBin, type FakeSshBin } from './fakeSshBin.js';
import { ensureSshClone, refreshSshClone, syncFromSshClone, type SshCloneContext } from './sshClone.js';
import { createNodeSshProcess } from './sshProcess.js';

/**
 * Part C against a real git and a real child process: the fake `ssh` from
 * `fakeSshBin` runs every remote script through a login shell in a temp
 * "remote machine", the way sshd does. No network, no real host.
 */

const BRANCH = 'feat/x';
const SAND = 'karst-ab-1-claude';
const CONTROL_DIR = `/tmp/karst-ssh-${String(typeof process.getuid === 'function' ? process.getuid() : 0)}/`;

let fake: FakeSshBin;
let hostRoot: string;
let remoteDir: string;
let ctx: SshCloneContext;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function gitCode(cwd: string, ...args: string[]): number {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return 0;
  } catch (err) {
    return typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 1;
  }
}

function remoteRepo(sandbox: string = SAND): string {
  return join(remoteDir, sandbox, 'repo');
}

function workspace(sandbox: string = SAND): string {
  return join(remoteDir, sandbox);
}

async function tmpLeftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith('tmp.'));
}

function context(sandbox: string = SAND): SshCloneContext {
  const remote: RemoteDef = { host: 'fake.example.com', user: 'karst', mode: 'direct', remoteDir };
  return {
    ssh: createNodeSshProcess({ sshBin: fake.ssh }),
    sshBin: fake.ssh,
    host: NODE_SBX_PROCESS,
    remote,
    remoteName: 'devbox',
    sandboxName: sandbox,
    controlDir: CONTROL_DIR,
  };
}

beforeAll(async () => {
  fake = await makeFakeSshBin();
  hostRoot = await mkdtemp(join(tmpdir(), 'karst-ssh-clone-host-'));
  remoteDir = join(fake.remoteRoot, 'srv', 'karst');
  git(hostRoot, 'init', '-q', '-b', 'main');
  git(hostRoot, 'config', 'user.name', 'Karst Test');
  git(hostRoot, 'config', 'user.email', 'karst@example.test');
  await writeFile(join(hostRoot, 'a.txt'), 'one\n');
  git(hostRoot, 'add', 'a.txt');
  git(hostRoot, 'commit', '-qm', 'first');
  git(hostRoot, 'checkout', '-q', '-b', BRANCH);
  ctx = context();
});

afterAll(async () => {
  await rm(hostRoot, { recursive: true, force: true });
  await fake.cleanup();
});

describe('an ssh clone round trip', () => {
  it('seeds the remote clone from a host bundle and is idempotent', async () => {
    await expect(ensureSshClone(ctx, { hostWorktreePath: hostRoot, branch: BRANCH })).resolves.toEqual({ ok: true });
    expect(git(remoteRepo(), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(git(remoteRepo(), 'config', 'user.name')).toBe('Karst Test');
    expect(git(remoteRepo(), 'config', 'user.email')).toBe('karst@example.test');
    expect(gitCode(remoteRepo(), 'remote', 'get-url', 'origin')).not.toBe(0);
    expect(await tmpLeftovers(workspace())).toEqual([]);

    await expect(ensureSshClone(ctx, { hostWorktreePath: hostRoot, branch: BRANCH })).resolves.toEqual({ ok: true });
    expect(await tmpLeftovers(workspace())).toEqual([]);
  });

  it('fast-forwards the host from a remote commit', async () => {
    await writeFile(join(remoteRepo(), 'remote.txt'), 'remote\n');
    git(remoteRepo(), 'add', 'remote.txt');
    git(remoteRepo(), 'commit', '-qm', 'remote commit');
    const remoteHead = git(remoteRepo(), 'rev-parse', 'HEAD');

    await expect(syncFromSshClone(ctx, { hostWorktreePath: hostRoot, branch: BRANCH })).resolves.toEqual({
      ok: true, summary: `fast-forwarded ${BRANCH} to the ssh sandbox's commits`,
    });
    expect(git(hostRoot, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(await tmpLeftovers(workspace())).toEqual([]);
  });

  it('fast-forwards the clone from a host commit', async () => {
    await writeFile(join(hostRoot, 'host.txt'), 'host\n');
    git(hostRoot, 'add', 'host.txt');
    git(hostRoot, 'commit', '-qm', 'host commit');
    const hostHead = git(hostRoot, 'rev-parse', 'HEAD');

    await expect(refreshSshClone(ctx, { hostWorktreePath: hostRoot, branch: BRANCH })).resolves.toEqual({
      ok: true, summary: `refreshed the ssh clone of ${BRANCH} on devbox from the host`,
    });
    expect(git(remoteRepo(), 'rev-parse', 'HEAD')).toBe(hostHead);
    expect(await tmpLeftovers(workspace())).toEqual([]);
  });

  it('refuses a divergence in both directions and never forces', async () => {
    await writeFile(join(remoteRepo(), 'remote-2.txt'), 'remote 2\n');
    git(remoteRepo(), 'add', 'remote-2.txt');
    git(remoteRepo(), 'commit', '-qm', 'remote diverges');
    const remoteHead = git(remoteRepo(), 'rev-parse', 'HEAD');

    await writeFile(join(hostRoot, 'host-2.txt'), 'host 2\n');
    git(hostRoot, 'add', 'host-2.txt');
    git(hostRoot, 'commit', '-qm', 'host diverges');
    const hostHead = git(hostRoot, 'rev-parse', 'HEAD');

    const refreshed = await refreshSshClone(ctx, { hostWorktreePath: hostRoot, branch: BRANCH });
    expect(refreshed.ok).toBe(false);
    if (!refreshed.ok) expect(refreshed.reason).toContain('diverged');
    expect(git(remoteRepo(), 'rev-parse', 'HEAD')).toBe(remoteHead);

    const synced = await syncFromSshClone(ctx, { hostWorktreePath: hostRoot, branch: BRANCH });
    expect(synced.ok).toBe(false);
    if (!synced.ok) expect(synced.reason).toContain('not a fast-forward');
    expect(git(hostRoot, 'rev-parse', 'HEAD')).toBe(hostHead);
  });

  it('leaves no temp file after a failed clone', async () => {
    const bad = context('karst-bad-clone');
    await expect(ensureSshClone(bad, { hostWorktreePath: hostRoot, branch: 'no-such-branch' })).resolves.toMatchObject({ ok: false });
    expect(await tmpLeftovers(workspace('karst-bad-clone'))).toEqual([]);
  });

  it('works with a login shell that rejects anything but the sh -c form (Part A.4)', async () => {
    const previous = process.env.KARST_FAKE_LOGIN_SHELL;
    process.env.KARST_FAKE_LOGIN_SHELL = fake.rejectLoginShell;
    try {
      await expect(ensureSshClone(context('karst-strict-shell'), { hostWorktreePath: hostRoot, branch: BRANCH })).resolves.toEqual({ ok: true });
      expect(git(remoteRepo('karst-strict-shell'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
      expect(await tmpLeftovers(workspace('karst-strict-shell'))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.KARST_FAKE_LOGIN_SHELL;
      else process.env.KARST_FAKE_LOGIN_SHELL = previous;
    }
  });
});
