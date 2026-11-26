import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { fakeSbxProcess } from '../sbx/fakeSbxProcess.js';
import { fakeSshProcess } from './fakeSshProcess.js';
import { SSH_BUNDLE_STDOUT_MAX_BYTES, SSH_TEXT_STDOUT_MAX_BYTES } from './sshCloneShared.js';
import {
  ensureSshClone,
  fetchSshClone,
  diffSshClone,
  rebuildSshCheck,
  refreshSshClone,
  sshCloneReady,
  sshRemotePaths,
  syncFromSshClone,
  type SshCloneContext,
} from './sshClone.js';

const REMOTE: RemoteDef = { host: 'fake.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst/' };
const SAND = 'karst-ab-1-claude';
const CONTEXT = { remoteName: 'devbox', sandboxName: SAND, controlDir: '/tmp/karst-ssh-0/' };
const WS = `/srv/karst/${SAND}`;
const REPO = `${WS}/repo`;
const WT = '/w t';
const BRANCH = 'feat/x';
const SHA = 'a'.repeat(40);
const HEAD_KEY = `git -C ${WT} rev-parse --verify --quiet refs/karst/sandbox/${BRANCH}^{commit}`;
const input = { hostWorktreePath: WT, branch: BRANCH };

type Ssh = ReturnType<typeof fakeSshProcess>;
type Host = ReturnType<typeof fakeSbxProcess>;

const ctx = (ssh: Ssh, host: Host = fakeSbxProcess()): SshCloneContext => ({
  ssh,
  sshBin: 'ssh',
  host,
  remote: REMOTE,
  ...CONTEXT,
});

const remoteCmd = (call: { args: readonly string[] }): string => call.args.at(-1) ?? '';
/** Decode the `sh -c '<script>'` wrapper back into the script, so assertions read like the shell. */
const scriptOf = (call: { args: readonly string[] }): string =>
  (remoteCmd(call).replace(/^sh -c '/s, '').replace(/'$/s, '')).split(`'\\''`).join("'");
const lines = (host: Host): string[] => host.calls.map((c) => [c.command, ...c.args].join(' '));
const argLines = (host: Host): string[] => host.calls.map((c) => c.args.join(' '));

describe('sshRemotePaths', () => {
  it('builds <remoteDir>/<sandboxName> with repo, bridge, env and gates', () => {
    expect(sshRemotePaths(ctx(fakeSshProcess()))).toEqual({
      workspace: WS, repo: REPO, bridge: `${WS}/bridge`, env: `${WS}/env`, gates: `${WS}/gates`,
    });
  });
});

describe('ensureSshClone', () => {
  it('is a no-op when the branch already resolves', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-clone-probe': { code: 0 } });
    await expect(ensureSshClone(ctx(ssh), input)).resolves.toEqual({ ok: true });
    expect(ssh.pipes).toHaveLength(0);
    expect(ssh.calls).toHaveLength(1);
    expect(remoteCmd(ssh.calls[0]!)).toContain('mkdir -p -m 0700');
  });

  it('streams a host bundle into a fresh clone, strips origin and sets the host identity', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-clone-probe': { code: 128 } });
    const host = fakeSbxProcess({
      [`git -C ${WT} config user.name`]: { stdout: 'Ann Dev\n' },
      [`git -C ${WT} config user.email`]: { stdout: 'ann@x.io\n' },
    });
    await expect(ensureSshClone(ctx(ssh, host), input)).resolves.toEqual({ ok: true });
    expect(ssh.pipes).toHaveLength(1);
    const { from, to } = ssh.pipes[0]!;
    expect(from.command).toBe('git');
    expect(from.args).toEqual(['-C', WT, 'bundle', 'create', '-', BRANCH]);
    expect(to.command).toBe('ssh');
    expect(remoteCmd(to).startsWith(`sh -c '`)).toBe(true);
    const script = scriptOf(to);
    expect(script).toContain(`tmp=$(mktemp -p '${WS}') && trap 'rm -f "$tmp"' EXIT`);
    expect(script).toContain(`git clone --no-hardlinks --branch '${BRANCH}' "$tmp" '${REPO}'`);
    expect(script).toContain(`git -C '${REPO}' remote remove origin`);
    expect(script).toContain(`git -C '${REPO}' config user.name 'Ann Dev'`);
    expect(script).toContain(`git -C '${REPO}' config user.email 'ann@x.io'`);
  });

  it('ships the base ref in the first bundle and pins it as refs/karst/base/<base>', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-clone-probe': { code: 128 } });
    await expect(ensureSshClone(ctx(ssh), { ...input, baseRef: 'develop' })).resolves.toEqual({ ok: true });
    const { from, to } = ssh.pipes[0]!;
    expect(from.args).toEqual(['-C', WT, 'bundle', 'create', '-', BRANCH, 'refs/remotes/origin/develop']);
    expect(scriptOf(to)).toContain(`+refs/remotes/origin/develop:refs/karst/base/develop`);
  });

  it('drops an unsafe base ref instead of passing it to git', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-clone-probe': { code: 128 } });
    await ensureSshClone(ctx(ssh), { ...input, baseRef: '--upload-pack=x' });
    expect(ssh.pipes[0]!.from.args).toEqual(['-C', WT, 'bundle', 'create', '-', BRANCH]);
  });

  it('reports a failed clone and a failed host bundle', async () => {
    const failedClone = fakeSshProcess({ 'karst-ssh-clone-probe': { code: 128 } }, { fromCode: 0, toCode: 1 });
    await expect(ensureSshClone(ctx(failedClone), input)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: clone of feat/x failed (exit 1)',
    });
    const failedBundle = fakeSshProcess({ 'karst-ssh-clone-probe': { code: 128 } }, { fromCode: 2, toCode: 1 });
    await expect(ensureSshClone(ctx(failedBundle), input)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: git bundle create feat/x failed (exit 2)',
    });
  });

  it('reports a transport failure of the probe without opening the pipe', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-clone-probe': { code: 255, stderr: 'Connection refused\n', transport: true } });
    await expect(ensureSshClone(ctx(ssh), input)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: transport failed during clone probe: Connection refused',
    });
    expect(ssh.pipes).toHaveLength(0);
  });
});

describe('syncFromSshClone', () => {
  function hostWithHead(): Host {
    return fakeSbxProcess({
      [HEAD_KEY]: { stdout: `${SHA}\n` },
      [`git -C ${WT} merge-base --is-ancestor HEAD ${SHA}`]: { code: 0 },
      [`git -C ${WT} merge --ff-only ${SHA}`]: { code: 0 },
    });
  }

  it('takes the thin bundle from stdout, fetches it and fast-forwards', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-thin-bundle': { stdout: 'bundle-bytes' } });
    const host = hostWithHead();
    await expect(syncFromSshClone(ctx(ssh, host), input)).resolves.toEqual({
      ok: true, summary: `fast-forwarded ${BRANCH} to the ssh sandbox's commits`,
    });
    const call = ssh.calls[0]!;
    expect(remoteCmd(call).startsWith(`sh -c '`)).toBe(true);
    expect(call.opts?.maxStdoutBytes).toBe(SSH_BUNDLE_STDOUT_MAX_BYTES);
    expect(scriptOf(call)).toContain(`bundle create -q - "$br"`);
    const l = argLines(host);
    expect(l.some((line) => line.includes('fetch --no-write-fetch-head') && line.includes('refs/karst/sandbox/feat/x'))).toBe(true);
    expect(l).toContain(`-C ${WT} merge --ff-only ${SHA}`);
    expect(l.join('\n')).not.toContain('FETCH_HEAD');
  });

  it('refuses a divergence and never merges', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-thin-bundle': { stdout: 'bundle-bytes' } });
    const host = fakeSbxProcess({
      [HEAD_KEY]: { stdout: `${SHA}\n` },
      [`git -C ${WT} merge-base --is-ancestor HEAD ${SHA}`]: { code: 1 },
      [`git -C ${WT} merge-base --is-ancestor ${SHA} HEAD`]: { code: 1 },
    });
    await expect(syncFromSshClone(ctx(ssh, host), input)).resolves.toEqual({
      ok: false, reason: `refused: the sandbox's ${BRANCH} is not a fast-forward of the host branch (never forced)`,
    });
    expect(lines(host).some((line) => line.includes('merge --ff-only'))).toBe(false);
  });

  it('reports a transport failure with the stderr tail', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-thin-bundle': { code: 255, stderr: 'a\nssh: connect to host fake port 22: refused\n', transport: true } });
    await expect(syncFromSshClone(ctx(ssh), input)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: transport failed during sync bundle: ssh: connect to host fake port 22: refused',
    });
  });

  it('reports a remote bundle failure', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-thin-bundle': { code: 1, stderr: 'fatal: not a git repository\n' } });
    await expect(syncFromSshClone(ctx(ssh), input)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: sync bundle failed: fatal: not a git repository',
    });
  });
});

describe('fetchSshClone and diffSshClone', () => {
  it('fetches without merging', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-thin-bundle': { stdout: 'b' } });
    const host = fakeSbxProcess({ [HEAD_KEY]: { stdout: `${SHA}\n` } });
    await expect(fetchSshClone(ctx(ssh, host), input)).resolves.toEqual({ ok: true });
    expect(lines(host).some((line) => line.includes('merge'))).toBe(false);
    expect(lines(host).some((line) => line.includes('fetch --no-write-fetch-head'))).toBe(true);
  });

  it('diffs HEAD against the resolved sandbox sha', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-thin-bundle': { stdout: 'b' } });
    const host = fakeSbxProcess({
      [HEAD_KEY]: { stdout: `${SHA}\n` },
      [`git -C ${WT} diff HEAD...${SHA}`]: { stdout: 'diff --git a/a b/a\n' },
    });
    await expect(diffSshClone(ctx(ssh, host), input)).resolves.toEqual({
      ok: true, diff: 'diff --git a/a b/a\n', ref: SHA,
    });
    expect(argLines(host)).toContain(`-C ${WT} diff HEAD...${SHA}`);
  });
});

describe('refreshSshClone', () => {
  it('streams the host bundle in and fast-forwards the clone', async () => {
    const ssh = fakeSshProcess();
    await expect(refreshSshClone(ctx(ssh), input)).resolves.toEqual({
      ok: true, summary: 'refreshed the ssh clone of feat/x on devbox from the host',
    });
    const { from, to } = ssh.pipes[0]!;
    expect(from.args).toEqual(['-C', WT, 'bundle', 'create', '-', BRANCH]);
    expect(to.command).toBe('ssh');
    const script = scriptOf(to);
    expect(remoteCmd(to).startsWith(`sh -c '`)).toBe(true);
    expect(script).toContain(`tmp=$(mktemp -p '${WS}') && trap 'rm -f "$tmp"' EXIT`);
    expect(script).toContain(`set -- '${BRANCH}' "$tmp"`);
    expect(script).toContain('git merge-base --is-ancestor HEAD FETCH_HEAD');
  });

  it('refuses a divergence', async () => {
    const ssh = fakeSshProcess({}, { fromCode: 0, toCode: 4 });
    await expect(refreshSshClone(ctx(ssh), input)).resolves.toEqual({
      ok: false, reason: `ssh devbox: refused: the host's ${BRANCH} diverged from the sandbox clone (never forced)`,
    });
  });

  it('re-reads a dirty refusal with its diff', async () => {
    const ssh = fakeSshProcess(
      { 'karst-ssh-refresh-diff': { stdout: 'karst-host-ahead 1\n M a.ts\n--- diff ---\n' } },
      { fromCode: 0, toCode: 3 },
    );
    const result = await refreshSshClone(ctx(ssh), input);
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
    await expect(refreshSshClone(ctx(ssh, host), input, { baseRef: 'develop' })).resolves.toMatchObject({ ok: true });
    expect(argLines(host)[0]).toBe(`-C ${WT} fetch origin +refs/heads/develop:refs/remotes/origin/develop`);
    expect(ssh.pipes[0]!.from.args).toEqual(['-C', WT, 'bundle', 'create', '-', BRANCH, 'refs/remotes/origin/develop']);
    expect(scriptOf(ssh.pipes[0]!.to)).toContain('refs/karst/base/$4');
  });

  it('refuses an unsafe base ref and reports a failed base fetch', async () => {
    const unsafeSsh = fakeSshProcess();
    await expect(refreshSshClone(ctx(unsafeSsh), input, { baseRef: '--upload-pack=x' })).resolves.toEqual({
      ok: false, reason: 'ssh devbox: refusing to ship base ref "--upload-pack=x"',
    });
    expect(unsafeSsh.calls).toHaveLength(0);
    const host = fakeSbxProcess({ [`git -C ${WT} fetch origin`]: { code: 1, stderr: 'no net\n' } });
    await expect(refreshSshClone(ctx(fakeSshProcess(), host), input, { baseRef: 'develop' })).resolves.toEqual({
      ok: false, reason: 'ssh devbox: git fetch origin develop failed: no net',
    });
  });

  it('reports a transport failure and a failed host bundle', async () => {
    const transport = fakeSshProcess({}, { fromCode: 0, toCode: 255 });
    await expect(refreshSshClone(ctx(transport), input)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: transport failed during refresh',
    });
    const bundle = fakeSshProcess({}, { fromCode: 1, toCode: 0 });
    await expect(refreshSshClone(ctx(bundle), input)).resolves.toEqual({
      ok: false, reason: `ssh devbox: git bundle create ${BRANCH} failed (exit 1)`,
    });
  });
});

describe('sshCloneReady', () => {
  it('is ready as soon as the branch resolves', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-clone-ready': { code: 0 } });
    await expect(sshCloneReady(ctx(ssh), BRANCH)).resolves.toEqual({ ok: true });
    expect(ssh.calls).toHaveLength(1);
  });

  it('polls until the timeout and then blocks', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-clone-ready': { code: 74 } });
    const slept: number[] = [];
    await expect(sshCloneReady(ctx(ssh), BRANCH, {
      timeoutMs: 3_000,
      intervalMs: 1_000,
      sleep: async (ms) => { slept.push(ms); },
    })).resolves.toEqual({ ok: false, reason: 'ssh devbox: the remote clone is empty: rebuild it from the host branch' });
    expect(ssh.calls).toHaveLength(4);
    expect(slept).toEqual([1_000, 1_000, 1_000]);
  });

  it('fails a transport failure instead of polling it away', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-clone-ready': { code: 255, stderr: 'down\n', transport: true } });
    await expect(sshCloneReady(ctx(ssh), BRANCH)).resolves.toEqual({
      ok: false, reason: 'ssh devbox: transport failed during clone-ready poll: down',
    });
  });
});

describe('rebuildSshCheck', () => {
  const listKey = 'karst-ssh-rebuild-refs';
  const dirtyKey = 'karst-ssh-rebuild-dirty';

  it('passes when every remote commit is on the host branch', async () => {
    const ssh = fakeSshProcess({ [listKey]: { stdout: `${SHA}\n` }, [dirtyKey]: { stdout: '' } });
    const host = fakeSbxProcess({ [`git -C ${WT} merge-base --is-ancestor ${SHA} ${BRANCH}`]: { code: 0 } });
    await expect(rebuildSshCheck(ctx(ssh, host), input)).resolves.toEqual({ ok: true });
    // Text reads are bounded too: a remote that prints without end fails closed.
    expect(ssh.calls.map((c) => c.opts?.maxStdoutBytes)).toEqual([SSH_TEXT_STDOUT_MAX_BYTES, SSH_TEXT_STDOUT_MAX_BYTES]);
  });

  it('refuses when the clone has uncommitted work', async () => {
    const ssh = fakeSshProcess({ [listKey]: { stdout: `${SHA}\n` }, [dirtyKey]: { stdout: ' M a.ts\n' } });
    await expect(rebuildSshCheck(ctx(ssh), input)).resolves.toMatchObject({ ok: false });
  });

  it('refuses a commit that is neither on the host branch nor on the sandbox ref', async () => {
    const ssh = fakeSshProcess({ [listKey]: { stdout: `${SHA}\n` }, [dirtyKey]: { stdout: '' } });
    const host = fakeSbxProcess({
      [`git -C ${WT} merge-base --is-ancestor ${SHA} ${BRANCH}`]: { code: 1 },
      [`git -C ${WT} rev-parse --verify --quiet refs/karst/sandbox/${BRANCH}^{commit}`]: { stdout: `${SHA}\n` },
      [`git -C ${WT} merge-base --is-ancestor ${SHA} refs/karst/sandbox/${BRANCH}`]: { code: 1 },
    });
    await expect(rebuildSshCheck(ctx(ssh, host), input)).resolves.toEqual({
      ok: false,
      reason: `ssh devbox: the remote clone holds commits (${SHA.slice(0, 12)}) that are not on ${BRANCH}, so it was not rebuilt: sync it first`,
    });
  });

  it('accepts a commit that is only on the sandbox ref', async () => {
    const ssh = fakeSshProcess({ [listKey]: { stdout: `${SHA}\n` }, [dirtyKey]: { stdout: '' } });
    const host = fakeSbxProcess({
      [`git -C ${WT} merge-base --is-ancestor ${SHA} ${BRANCH}`]: { code: 1 },
      [`git -C ${WT} rev-parse --verify --quiet refs/karst/sandbox/${BRANCH}^{commit}`]: { stdout: `${SHA}\n` },
      [`git -C ${WT} merge-base --is-ancestor ${SHA} refs/karst/sandbox/${BRANCH}`]: { code: 0 },
    });
    await expect(rebuildSshCheck(ctx(ssh, host), input)).resolves.toEqual({ ok: true });
  });
});
