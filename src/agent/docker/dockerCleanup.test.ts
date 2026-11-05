import { describe, expect, it } from 'vitest';
import { buildCachePruneArgs, cleanupAfterBuild, BUILD_CACHE_KEEP_GB, BUILD_CACHE_MAX_AGE, PRUNE_CACHE_HINT } from './dockerCleanup.js';
import { OPENCODE_IMAGE, OPENCODE_IMAGE_REPOSITORY } from './dockerImage.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';

const lines = (p: ReturnType<typeof fakeDockerProcess>) => p.calls.map((c) => [c.command, ...c.args].join(' '));
const OLD = `${OPENCODE_IMAGE_REPOSITORY}:1.19.0-2.0.27-r2`;
const BUSY = `${OPENCODE_IMAGE_REPOSITORY}:busy`;

describe('cleanupAfterBuild', () => {
  it('removes unused superseded tags, keeps the current, in-use, other-repo and dangling ones', async () => {
    const proc = fakeDockerProcess({
      'docker image ls': { stdout: `${OPENCODE_IMAGE}\n${OLD}\n${BUSY}\n${OPENCODE_IMAGE_REPOSITORY}:<none>\npostgres:16\nkarst/opencode-sandboxer:x\n` },
      [`docker ps -a -q --filter ancestor=${BUSY}`]: { stdout: 'abc123\n' },
    });
    const log: string[] = [];
    await cleanupAfterBuild(proc, (m) => log.push(m));
    expect(lines(proc)).toEqual([
      `docker image ls ${OPENCODE_IMAGE_REPOSITORY} --format {{.Repository}}:{{.Tag}}`,
      `docker ps -a -q --filter ancestor=${OLD}`,
      `docker image rm ${OLD}`,
      `docker ps -a -q --filter ancestor=${BUSY}`,
      `docker builder prune --force --filter until=${BUILD_CACHE_MAX_AGE} --keep-storage ${BUILD_CACHE_KEEP_GB}GB`,
    ]);
    expect(log).toContain(`sandbox image cleanup: removed ${OLD}`);
    expect(log).toContain(`sandbox image cleanup: keeping ${BUSY}, a container uses it`);
    expect(PRUNE_CACHE_HINT).toBe(buildCachePruneArgs().filter((a) => a !== '--force').join(' ').replace(/^/, 'docker '));
  });

  it('logs a failed rm and still prunes the cache', async () => {
    const proc = fakeDockerProcess({ 'docker image ls': { stdout: `${OLD}\n` }, 'docker image rm': { code: 1, stderr: 'conflict\nmore' } });
    const log: string[] = [];
    await cleanupAfterBuild(proc, (m) => log.push(m));
    expect(log).toContain(`sandbox image cleanup: rm ${OLD} failed (1): conflict`);
    expect(lines(proc).at(-1)).toContain('docker builder prune');
  });

  it('logs a failed ls, a failed ps and a failed prune without throwing', async () => {
    const log: string[] = [];
    await cleanupAfterBuild(fakeDockerProcess({ 'docker image ls': { code: 1, stderr: 'boom' }, 'docker builder': { code: 1, stderr: 'nope' } }), (m) => log.push(m));
    expect(log).toEqual(['sandbox image cleanup: image ls failed (1): boom', 'sandbox build cache prune failed (1): nope']);
    const log2: string[] = [];
    const proc = fakeDockerProcess({ 'docker image ls': { stdout: `${OLD}\n` }, 'docker ps': { code: 1, stderr: 'ps bad' }, 'docker builder': { stdout: 'Total: 1GB\n' } });
    await cleanupAfterBuild(proc, (m) => log2.push(m));
    expect(lines(proc)).not.toContain(`docker image rm ${OLD}`);
    expect(log2).toEqual([`sandbox image cleanup: cannot check containers for ${OLD}: ps bad`, 'sandbox build cache pruned: Total: 1GB']);
  });

  it('never throws when the process rejects', async () => {
    const log: string[] = [];
    await cleanupAfterBuild({ run: () => Promise.reject(new Error('EPERM')), pipe: () => Promise.reject(new Error('x')) }, (m) => log.push(m));
    expect(log).toEqual(['sandbox image cleanup failed: EPERM', 'sandbox build cache prune failed: EPERM']);
    const log2: string[] = [];
    await cleanupAfterBuild({ run: () => Promise.reject('str'), pipe: () => Promise.reject(new Error('x')) }, (m) => log2.push(m));
    expect(log2[0]).toBe('sandbox image cleanup failed: str');
  });

  it('defaults to a silent debug', async () => {
    await expect(cleanupAfterBuild(fakeDockerProcess())).resolves.toBeUndefined();
  });
});
