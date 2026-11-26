import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { fakeSbxProcess } from '../sbx/fakeSbxProcess.js';
import { fakeSshProcess } from './fakeSshProcess.js';
import {
  diffSshDockerClone,
  ensureSshDockerClone,
  fetchSshDockerClone,
  refreshSshDockerClone,
  sshDockerHelper,
  syncFromSshDockerClone,
  type SshDockerCloneContext,
} from './sshDockerClone.js';

const REMOTE: RemoteDef = { host: 'fake.example.com', user: 'karst', mode: 'docker', remoteDir: '/srv/karst/' };
const CONTROL = '/tmp/karst-ssh-0/';
const IMAGE = 'karst/opencode:1';
const VOLUME = 'karst-clone-vol';
const WT = '/w t';
const BRANCH = 'feat/x';
const SHA = 'a'.repeat(40);
const HEAD_KEY = `git -C ${WT} rev-parse --verify --quiet refs/karst/sandbox/${BRANCH}^{commit}`;
const PROBE = '# karst-ssh-docker-clone-probe';
const THIN = '# karst-ssh-docker-thin-bundle';
const REFRESH_DIFF = '# karst-ssh-docker-refresh-diff';
const input = { hostWorktreePath: WT, branch: BRANCH };

type Ssh = ReturnType<typeof fakeSshProcess>;
type Host = ReturnType<typeof fakeSbxProcess>;

const ctx = (ssh: Ssh, host: Host = fakeSbxProcess(), extra: Partial<SshDockerCloneContext> = {}): SshDockerCloneContext => ({
  ssh,
  sshBin: 'ssh',
  host,
  remote: REMOTE,
  remoteName: 'devbox',
  controlDir: CONTROL,
  image: IMAGE,
  volume: VOLUME,
  ...extra,
});

const remoteCmd = (call: { args: readonly string[] }): string => call.args.at(-1) ?? '';
/** Decode the `sh -c '<script>'` wrapper back into the script, so assertions read like the shell. */
const scriptOf = (call: { args: readonly string[] }): string =>
  remoteCmd(call).replace(/^sh -c '/s, '').replace(/'$/s, '').split(`'\\''`).join("'");
/** The container script: the second quoting layer (`docker run … sh -c '<script>'`) decoded. */
const dockerScriptOf = (call: { args: readonly string[] }): string => {
  const inner = scriptOf(call);
  const marker = ` sh -c '`;
  const at = inner.lastIndexOf(marker);
  const quoted = inner.slice(at + marker.length, inner.lastIndexOf(`'`));
  return quoted.split(`'\\''`).join("'");
};
const argLines = (host: Host): string[] => host.calls.map((c) => c.args.join(' '));

describe('sshDockerHelper', () => {
  it('builds the seam argv: hardened ssh options, --, then one docker run under sh -c', () => {
    const argv = sshDockerHelper(REMOTE, CONTROL, IMAGE, VOLUME, 'echo hi');
    expect(argv.at(-3)).toBe('--');
    expect(argv.at(-2)).toBe('karst@fake.example.com');
    expect(remoteCmd({ args: argv }).startsWith(`sh -c '`)).toBe(true);
    const inner = scriptOf({ args: argv });
    expect(inner).toBe(
      `docker run --rm -i --network none --cap-drop ALL --security-opt no-new-privileges -v ${VOLUME}:/work ${IMAGE} sh -c 'echo hi'`,
    );
  });

  it('never mounts a host path: the -v value is the named volume and /work', () => {
    const argv = sshDockerHelper(REMOTE, CONTROL, IMAGE, VOLUME, 'echo hi');
    const tokens = scriptOf({ args: argv }).split(' ');
    const at = tokens.indexOf('-v');
    expect(tokens[at + 1]).toBe(`${VOLUME}:/work`);
    expect(tokens[at + 1]!.startsWith('/')).toBe(false);
    expect(argv.join(' ')).not.toContain(WT);
  });

  it('rejects a host path as the image or the volume before any spawn', async () => {
    expect(() => sshDockerHelper(REMOTE, CONTROL, '/tmp/img', VOLUME, 'true')).toThrow(/image/);
    expect(() => sshDockerHelper(REMOTE, CONTROL, IMAGE, '/Users/nd/vol', 'true')).toThrow(/volume/);
    const ssh = fakeSshProcess();
    await expect(ensureSshDockerClone(ctx(ssh, fakeSbxProcess(), { image: '/tmp/img' }), input)).resolves.toMatchObject({
      ok: false, reason: expect.stringContaining('image'),
    });
    await expect(ensureSshDockerClone(ctx(ssh, fakeSbxProcess(), { volume: '/Users/nd/vol' }), input)).resolves.toMatchObject({
      ok: false, reason: expect.stringContaining('volume'),
    });
    expect(ssh.calls).toHaveLength(0);
    expect(ssh.pipes).toHaveLength(0);
  });
});

describe('ensureSshDockerClone', () => {
  it('is a no-op when the container clone already has the branch', async () => {
    const ssh = fakeSshProcess({ [PROBE]: { code: 0 } });
    await expect(ensureSshDockerClone(ctx(ssh), input)).resolves.toEqual({ ok: true });
    expect(ssh.pipes).toHaveLength(0);
    expect(ssh.calls).toHaveLength(1);
    expect(scriptOf(ssh.calls[0]!)).toContain('git -c ');
  });

  it('pipes a host bundle into docker run -i and seeds the clone in the volume', async () => {
    const ssh = fakeSshProcess({ [PROBE]: { code: 128 } });
    const host = fakeSbxProcess({
      [`git -C ${WT} config user.name`]: { stdout: 'Ann Dev\n' },
      [`git -C ${WT} config user.email`]: { stdout: 'ann@x.io\n' },
    });
    await expect(ensureSshDockerClone(ctx(ssh, host), input)).resolves.toEqual({ ok: true });
    expect(ssh.pipes).toHaveLength(1);
    const { from, to } = ssh.pipes[0]!;
    expect(from.command).toBe('git');
    expect(from.args).toEqual(['-C', WT, 'bundle', 'create', '-', BRANCH]);
    expect(to.command).toBe('ssh');
    const inner = scriptOf(to);
    expect(inner).toContain('docker run --rm -i --network none --cap-drop ALL --security-opt no-new-privileges');
    expect(inner).toContain(`-v ${VOLUME}:/work ${IMAGE}`);
    const script = dockerScriptOf(to);
    expect(script).toContain(`trap 'rm -f /work/in.bundle' EXIT`);
    expect(script).toContain(`cat > '/work/in.bundle'`);
    expect(script).toContain(`git -c 'safe.directory=*' clone --no-hardlinks --branch '${BRANCH}' '/work/in.bundle' '/work/repo'`);
    expect(script).toContain(`git -c 'safe.directory=*' -C '/work/repo' remote remove origin`);
    expect(script).toContain(`git -c 'safe.directory=*' -C '/work/repo' config user.name 'Ann Dev'`);
    expect(script).toContain(`git -c 'safe.directory=*' -C '/work/repo' config user.email 'ann@x.io'`);
  });

  it('ships the base ref as refs/karst/base/<base> inside the same bundle', async () => {
    const ssh = fakeSshProcess({ [PROBE]: { code: 128 } });
    await expect(ensureSshDockerClone(ctx(ssh), { ...input, baseRef: 'develop' })).resolves.toEqual({ ok: true });
    const { from, to } = ssh.pipes[0]!;
    expect(from.args).toEqual(['-C', WT, 'bundle', 'create', '-', BRANCH, 'refs/remotes/origin/develop']);
    expect(scriptOf(to)).toContain('+refs/remotes/origin/develop:refs/karst/base/develop');
  });

  it('reports a failed clone, a failed host bundle and a transport failure', async () => {
    const failedClone = fakeSshProcess({ [PROBE]: { code: 128 } }, { fromCode: 0, toCode: 1 });
    await expect(ensureSshDockerClone(ctx(failedClone), input)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: clone of feat/x failed (exit 1)',
    });
    const failedBundle = fakeSshProcess({ [PROBE]: { code: 128 } }, { fromCode: 2, toCode: 1 });
    await expect(ensureSshDockerClone(ctx(failedBundle), input)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: git bundle create feat/x failed (exit 2)',
    });
    const transport = fakeSshProcess({ [PROBE]: { code: 255, stderr: 'Connection refused\n', transport: true } });
    await expect(ensureSshDockerClone(ctx(transport), input)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: transport failed during clone probe: Connection refused',
    });
    expect(transport.pipes).toHaveLength(0);
  });
});

describe('syncFromSshDockerClone', () => {
  function hostWithHead(): Host {
    return fakeSbxProcess({
      [HEAD_KEY]: { stdout: `${SHA}\n` },
      [`git -C ${WT} merge-base --is-ancestor HEAD ${SHA}`]: { code: 0 },
      [`git -C ${WT} merge --ff-only ${SHA}`]: { code: 0 },
    });
  }

  it('runs THIN_OUT_SCRIPT in the container, fetches the bytes and fast-forwards', async () => {
    const ssh = fakeSshProcess({ [THIN]: { stdout: 'bundle-bytes' } });
    const host = hostWithHead();
    await expect(syncFromSshDockerClone(ctx(ssh, host), input)).resolves.toEqual({
      ok: true, summary: `fast-forwarded ${BRANCH} to the ssh sandbox's commits`,
    });
    const inner = scriptOf(ssh.calls[0]!);
    const script = dockerScriptOf(ssh.calls[0]!);
    expect(inner).toContain(`docker run --rm -i --network none --cap-drop ALL --security-opt no-new-privileges`);
    expect(script).toContain(`set -- - '${BRANCH}'`);
    expect(script).toContain('bundle create -q "$out"');
    const l = argLines(host);
    expect(l.some((line) => line.includes('fetch --no-write-fetch-head') && line.includes('refs/karst/sandbox/feat/x'))).toBe(true);
    expect(l).toContain(`-C ${WT} merge --ff-only ${SHA}`);
    expect(l.join('\n')).not.toContain('FETCH_HEAD');
  });

  it('refuses a divergence and never merges', async () => {
    const ssh = fakeSshProcess({ [THIN]: { stdout: 'b' } });
    const host = fakeSbxProcess({
      [HEAD_KEY]: { stdout: `${SHA}\n` },
      [`git -C ${WT} merge-base --is-ancestor HEAD ${SHA}`]: { code: 1 },
      [`git -C ${WT} merge-base --is-ancestor ${SHA} HEAD`]: { code: 1 },
    });
    await expect(syncFromSshDockerClone(ctx(ssh, host), input)).resolves.toEqual({
      ok: false, reason: `refused: the sandbox's ${BRANCH} is not a fast-forward of the host branch (never forced)`,
    });
    expect(argLines(host).some((line) => line.includes('merge --ff-only'))).toBe(false);
  });

  it('reports a transport failure with the stderr tail', async () => {
    const ssh = fakeSshProcess({ [THIN]: { code: 255, stderr: 'down\n', transport: true } });
    await expect(syncFromSshDockerClone(ctx(ssh), input)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: transport failed during sync bundle: down',
    });
  });
});

describe('fetchSshDockerClone and diffSshDockerClone', () => {
  it('fetches without merging', async () => {
    const ssh = fakeSshProcess({ [THIN]: { stdout: 'b' } });
    const host = fakeSbxProcess({ [HEAD_KEY]: { stdout: `${SHA}\n` } });
    await expect(fetchSshDockerClone(ctx(ssh, host), input)).resolves.toEqual({ ok: true });
    expect(argLines(host).some((line) => line.includes('merge'))).toBe(false);
    expect(argLines(host).some((line) => line.includes('fetch --no-write-fetch-head'))).toBe(true);
  });

  it('diffs HEAD against the resolved sandbox sha', async () => {
    const ssh = fakeSshProcess({ [THIN]: { stdout: 'b' } });
    const host = fakeSbxProcess({
      [HEAD_KEY]: { stdout: `${SHA}\n` },
      [`git -C ${WT} diff HEAD...${SHA}`]: { stdout: 'diff --git a/a b/a\n' },
    });
    await expect(diffSshDockerClone(ctx(ssh, host), input)).resolves.toEqual({
      ok: true, diff: 'diff --git a/a b/a\n', ref: SHA,
    });
    expect(argLines(host)).toContain(`-C ${WT} diff HEAD...${SHA}`);
  });
});

describe('refreshSshDockerClone', () => {
  it('pipes the host bundle into the container and fast-forwards the clone', async () => {
    const ssh = fakeSshProcess();
    await expect(refreshSshDockerClone(ctx(ssh), input)).resolves.toEqual({
      ok: true, summary: `refreshed the docker ssh clone of ${BRANCH} on devbox from the host`,
    });
    const { from, to } = ssh.pipes[0]!;
    expect(from.args).toEqual(['-C', WT, 'bundle', 'create', '-', BRANCH]);
    const inner = scriptOf(to);
    expect(inner).toContain(`-v ${VOLUME}:/work ${IMAGE}`);
    const script = dockerScriptOf(to);
    expect(script).toContain(`cd '/work/repo'`);
    expect(script).toContain(`trap 'rm -f /work/in.bundle' EXIT`);
    expect(script).toContain(`cat > '/work/in.bundle'`);
    expect(script).toContain(`set -- '${BRANCH}' '/work/in.bundle'`);
    expect(script).toContain('git merge-base --is-ancestor HEAD FETCH_HEAD');
  });

  it('refuses a divergence', async () => {
    const ssh = fakeSshProcess({}, { fromCode: 0, toCode: 4 });
    await expect(refreshSshDockerClone(ctx(ssh), input)).resolves.toEqual({
      ok: false, reason: `ssh devbox: refused: the host's ${BRANCH} diverged from the sandbox clone (never forced)`,
    });
  });

  it('re-reads a dirty refusal with its diff', async () => {
    const ssh = fakeSshProcess(
      { [REFRESH_DIFF]: { stdout: 'karst-host-ahead 1\n M a.ts\n--- diff ---\n' } },
      { fromCode: 0, toCode: 3 },
    );
    const result = await refreshSshDockerClone(ctx(ssh), input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('host is ahead by 1 commit(s)');
      expect(result.reason).toContain('M a.ts');
    }
    expect(ssh.calls).toHaveLength(1);
  });

  it('ships origin/<base> and force-updates refs/karst/base/<base>', async () => {
    const ssh = fakeSshProcess();
    const host = fakeSbxProcess();
    await expect(refreshSshDockerClone(ctx(ssh, host), input, { baseRef: 'develop' })).resolves.toMatchObject({ ok: true });
    expect(argLines(host)[0]).toBe(`-C ${WT} fetch origin +refs/heads/develop:refs/remotes/origin/develop`);
    expect(ssh.pipes[0]!.from.args).toEqual(['-C', WT, 'bundle', 'create', '-', BRANCH, 'refs/remotes/origin/develop']);
    expect(scriptOf(ssh.pipes[0]!.to)).toContain('refs/karst/base/$4');
  });

  it('refuses an unsafe base ref and a failed host bundle', async () => {
    const unsafeSsh = fakeSshProcess();
    await expect(refreshSshDockerClone(ctx(unsafeSsh), input, { baseRef: '--upload-pack=x' })).resolves.toEqual({
      ok: false, reason: 'ssh devbox: refusing to ship base ref "--upload-pack=x"',
    });
    expect(unsafeSsh.calls).toHaveLength(0);
    const bundle = fakeSshProcess({}, { fromCode: 1, toCode: 0 });
    await expect(refreshSshDockerClone(ctx(bundle), input)).resolves.toEqual({
      ok: false, reason: `ssh devbox: git bundle create ${BRANCH} failed (exit 1)`,
    });
  });
});

describe('every host git call', () => {
  it('carries -C <hostWorktreePath>', async () => {
    const ssh = fakeSshProcess({ [PROBE]: { code: 128 }, [THIN]: { stdout: 'b' } });
    const host = fakeSbxProcess({ [HEAD_KEY]: { stdout: `${SHA}\n` } });
    await ensureSshDockerClone(ctx(ssh, host), input);
    await syncFromSshDockerClone(ctx(ssh, host), input);
    await diffSshDockerClone(ctx(ssh, host), input);
    await refreshSshDockerClone(ctx(ssh, host), input);
    expect(host.calls.length).toBeGreaterThan(0);
    for (const call of host.calls) {
      expect(call.command).toBe('git');
      expect(call.args.slice(0, 2)).toEqual(['-C', WT]);
    }
  });
});
