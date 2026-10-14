import { describe, expect, it } from 'vitest';
import { OPENCODE_IMAGE } from './dockerImage.js';
import { dockerPreflight } from './dockerPreflight.js';
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
    expect(lines(proc)[2]).toBe(`docker build --tag ${OPENCODE_IMAGE} --build-arg OC1=1.19.0 --build-arg OC2=2.0.27 ${CTX}`);
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
});
