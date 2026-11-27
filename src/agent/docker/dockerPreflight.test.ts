import { describe, expect, it, vi } from 'vitest';
import { OPENCODE_IMAGE, PLAYWRIGHT_VERSION } from './dockerImage.js';
import { dockerPreflight, REMOTE_BUILD_TIMEOUT_MS } from './dockerPreflight.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';

const CTX = '/ext/dist/sandbox/opencode';
const lines = (proc: ReturnType<typeof fakeDockerProcess>) => proc.calls.map((c) => [c.command, ...c.args].join(' '));

describe('dockerPreflight', () => {
  it('passes when the daemon answers and the image exists', async () => {
    const proc = fakeDockerProcess({ 'docker version': { stdout: '29.1.3\n' } });
    await expect(dockerPreflight(proc, CTX)).resolves.toEqual({ ok: true });
    expect(lines(proc)).toEqual([
      'docker version --format {{.Server.Version}}',
      `docker image inspect --format {{.Id}} ${OPENCODE_IMAGE}`,
    ]);
  });

  it('reports a missing binary', async () => {
    const proc = fakeDockerProcess({ 'docker version': { code: 127 } });
    await expect(dockerPreflight(proc, CTX)).resolves.toEqual({ ok: false, reason: 'docker not installed (not on PATH)' });
    expect(proc.calls).toHaveLength(1);
  });

  it('reports an unreachable daemon with its first error line', async () => {
    const proc = fakeDockerProcess({ 'docker version': { code: 1, stderr: 'Cannot connect to the Docker daemon\nmore' } });
    await expect(dockerPreflight(proc, CTX)).resolves.toEqual({
      ok: false,
      reason: 'docker daemon not reachable: Cannot connect to the Docker daemon',
    });
  });

  it('builds a missing image from the shipped context', async () => {
    const proc = fakeDockerProcess({ 'docker image inspect': { code: 1 } });
    await expect(dockerPreflight(proc, CTX)).resolves.toEqual({ ok: true });
    expect(lines(proc)[2]).toBe(
      `docker build --tag ${OPENCODE_IMAGE} --build-arg OC1=1.19.0 --build-arg OC2=2.0.27 ` +
        `--build-arg PW=${PLAYWRIGHT_VERSION} --build-arg AGY=1.4.6 ${CTX}`,
    );
  });

  it('reports a failed build', async () => {
    const proc = fakeDockerProcess({ 'docker image inspect': { code: 1 }, 'docker build': { code: 1, stdout: 'step 1\nnpm ERR! 404\n' } });
    await expect(dockerPreflight(proc, CTX)).resolves.toEqual({
      ok: false,
      reason: `docker build ${OPENCODE_IMAGE} failed: npm ERR! 404`,
    });
  });

  it('never throws: a rejecting process becomes a reason', async () => {
    const proc = { run: () => Promise.reject(new Error('EPERM')), pipe: () => Promise.reject(new Error('x')) };
    await expect(dockerPreflight(proc, CTX)).resolves.toEqual({ ok: false, reason: 'docker preflight failed: EPERM' });
  });

  it('stringifies a non-Error rejection', async () => {
    const proc = { run: () => Promise.reject('nope'), pipe: () => Promise.reject(new Error('x')) };
    await expect(dockerPreflight(proc, CTX)).resolves.toEqual({ ok: false, reason: 'docker preflight failed: nope' });
  });

  it('cleans up after a successful build only', async () => {
    const built = fakeDockerProcess({ 'docker image inspect': { code: 1 } });
    await dockerPreflight(built, CTX);
    expect(lines(built).some((l) => l.startsWith('docker builder prune'))).toBe(true);
    const failed = fakeDockerProcess({ 'docker image inspect': { code: 1 }, 'docker build': { code: 1 } });
    await dockerPreflight(failed, CTX);
    expect(lines(failed).some((l) => l.startsWith('docker builder prune'))).toBe(false);
    const present = fakeDockerProcess();
    await dockerPreflight(present, CTX);
    expect(lines(present).some((l) => l.startsWith('docker builder prune'))).toBe(false);
  });
});

const BUILD_ARGV = [
  'build', '--tag', OPENCODE_IMAGE,
  '--build-arg', 'OC1=1.19.0', '--build-arg', 'OC2=2.0.27',
  '--build-arg', `PW=${PLAYWRIGHT_VERSION}`, '--build-arg', 'AGY=1.4.6', '-',
];

describe('dockerPreflight streamContext (remote daemon, T1399)', () => {
  it('leaves the local path build untouched when streamContext is not set', async () => {
    const proc = fakeDockerProcess({ 'docker image inspect': { code: 1 } });
    await expect(dockerPreflight(proc, CTX)).resolves.toEqual({ ok: true });
    expect(proc.pipes).toHaveLength(0);
    expect(lines(proc)[2]).toContain(`${CTX}`);
  });

  it('streams the tar context into docker build - and cleans up only on success', async () => {
    const proc = fakeDockerProcess({ 'docker image inspect': { code: 1 } });
    const onProgress = vi.fn();
    await expect(dockerPreflight(proc, CTX, () => undefined, { streamContext: true, onProgress })).resolves.toEqual({ ok: true });
    expect(proc.pipes).toHaveLength(1);
    expect(proc.pipes[0]!.from).toEqual({ command: 'tar', args: ['-c', '-C', CTX, '.'] });
    expect(proc.pipes[0]!.to).toEqual({ command: 'docker', args: BUILD_ARGV });
    // The build names its own bound: the generic 60 s pipe bound would SIGKILL a cold build.
    expect(proc.pipes[0]!.opts?.timeoutMs).toBe(REMOTE_BUILD_TIMEOUT_MS);
    // Never a path build, never a pull.
    expect(lines(proc).some((l) => /^docker build /.test(l))).toBe(false);
    expect(lines(proc).some((l) => l.startsWith('docker pull'))).toBe(false);
    expect(proc.pipes[0]!.to.args).not.toContain('--pull');
    expect(lines(proc).some((l) => l.startsWith('docker builder prune'))).toBe(true);
    expect(onProgress).toHaveBeenCalledWith(`building ${OPENCODE_IMAGE} on remote daemon…`);
  });

  it('hands the caller\'s deadline to the build pipe, so a resolve timeout kills it', async () => {
    const proc = fakeDockerProcess({ 'docker image inspect': { code: 1 } });
    const controller = new AbortController();
    await expect(dockerPreflight(proc, CTX, () => undefined, {
      streamContext: true, signal: controller.signal, buildTimeoutMs: 1234,
    })).resolves.toEqual({ ok: true });
    expect(proc.pipes[0]!.opts).toMatchObject({ timeoutMs: 1234, signal: controller.signal });
  });

  it('never pulls when the image exists', async () => {
    const proc = fakeDockerProcess();
    await expect(dockerPreflight(proc, CTX, () => undefined, { streamContext: true })).resolves.toEqual({ ok: true });
    expect(proc.pipes).toHaveLength(0);
    expect(lines(proc)).toEqual([
      'docker version --format {{.Server.Version}}',
      `docker image inspect --format {{.Id}} ${OPENCODE_IMAGE}`,
    ]);
  });

  it('reports a tar failure without running the build cleanup', async () => {
    const proc = fakeDockerProcess({ 'docker image inspect': { code: 1 } }, { fromCode: 2, toCode: 0 });
    await expect(dockerPreflight(proc, CTX, () => undefined, { streamContext: true })).resolves.toEqual({
      ok: false, reason: 'tar of the docker build context failed (exit 2)',
    });
    expect(lines(proc).some((l) => l.startsWith('docker builder prune'))).toBe(false);
  });

  it('reports a build failure with its exit code', async () => {
    const proc = fakeDockerProcess({ 'docker image inspect': { code: 1 } }, { fromCode: 0, toCode: 1 });
    await expect(dockerPreflight(proc, CTX, () => undefined, { streamContext: true })).resolves.toEqual({
      ok: false, reason: `docker build ${OPENCODE_IMAGE} failed (exit 1)`,
    });
    expect(lines(proc).some((l) => l.startsWith('docker builder prune'))).toBe(false);
  });

  it('reads exit 255 as a transport failure, never as a docker build failure', async () => {
    const proc = fakeDockerProcess({ 'docker image inspect': { code: 1 } }, { fromCode: 0, toCode: 255 });
    await expect(dockerPreflight(proc, CTX, () => undefined, { streamContext: true })).resolves.toEqual({
      ok: false, reason: `docker build ${OPENCODE_IMAGE} lost the remote connection (exit 255)`,
    });
  });

  it('fails clearly when the version probe is a transport failure', async () => {
    const proc = fakeDockerProcess({ 'docker version': { code: 255, stderr: 'ssh: connect to host vm port 22: refused', transport: true } });
    await expect(dockerPreflight(proc, CTX, () => undefined, { streamContext: true })).resolves.toEqual({
      ok: false, reason: 'docker daemon not reachable over the remote transport: ssh: connect to host vm port 22: refused',
    });
    expect(proc.calls).toHaveLength(1);
  });

  it('fails clearly when the image probe is a transport failure, and never streams', async () => {
    const proc = fakeDockerProcess({
      'docker version': { stdout: '29.1.3\n' },
      'docker image inspect': { code: 255, stderr: 'Connection closed by remote host', transport: true },
    });
    await expect(dockerPreflight(proc, CTX, () => undefined, { streamContext: true })).resolves.toEqual({
      ok: false, reason: '`docker image inspect` did not reach the remote daemon: Connection closed by remote host',
    });
    expect(proc.pipes).toHaveLength(0);
  });
});
