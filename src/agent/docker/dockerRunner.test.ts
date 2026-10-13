import { describe, expect, it, vi } from 'vitest';
import type { HeadlessSpawnResult } from '../headlessSpawn.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import { dockerNames } from './dockerNames.js';
import { interactiveRunArgs } from './dockerRunArgs.js';
import { createDockerSessionRunner, prepareDockerSandbox } from './dockerRunner.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';
import { autonomousPermissionArgs } from '../sbx/sbxRunner.js';
import { HOST_SESSION_RUNNER } from '../sessionRunner.js';

const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' });
const other = dockerNames({ projectRoot: '/p', ticketId: 8, core: 'opencode' });
const WT = '/w/t7';
const ticket = { hostWorktreePath: WT, branch: 'feat/x' };
const temp = { make: () => Promise.resolve('/tmp/k1'), remove: () => Promise.resolve() };
const lines = (proc: ReturnType<typeof fakeDockerProcess>) => proc.calls.map((c) => [c.command, ...c.args].join(' '));
const OK: HeadlessSpawnResult = { stdout: 'PONG', stderr: '', exitCode: 0 } as unknown as HeadlessSpawnResult;

describe('createDockerSessionRunner', () => {
  it('enforces a sandbox and places the interactive docker run in the host worktree', () => {
    const proc = fakeDockerProcess();
    const runner = createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined, authFile: '/h/auth.json' });
    expect(runner.kind).toBe('docker');
    expect(runner.enforcesSandbox).toBe(true);
    const spec = { ticketId: 7, hostWorktreePath: WT, command: 'opencode', args: [WT], env: { OPENCODE_PURE: '0' } };
    expect(runner.placeInteractive(spec)).toEqual({
      cwd: WT,
      shellPath: 'docker',
      shellArgs: interactiveRunArgs({ names, core: 'opencode', user: undefined, authFile: '/h/auth.json', hostWorktreePath: WT, args: [WT], env: spec.env }),
      env: { OPENCODE_PURE: '0' },
    });
    expect(proc.calls).toHaveLength(0);
  });

  it('runs headless through docker exec with the image launcher and rewritten paths', async () => {
    const spawnHeadless = vi.fn().mockResolvedValue(OK);
    const runner = createDockerSessionRunner({ proc: fakeDockerProcess(), core: 'opencode2', names, user: undefined, spawnHeadless, newRunId: () => 'r1' });
    await expect(runner.runHeadless('/abs/opencode2', ['run', '--dir', WT], WT, { timeoutMs: 5 })).resolves.toBe(OK);
    expect(spawnHeadless).toHaveBeenCalledWith('docker', [
      'exec', '--interactive', '--workdir', '/work/repo', names.container,
      'sh', '-c', 'echo $$ > "/tmp/karst-run-$1.pid"; shift; exec "$@"', 'karst-run', 'r1',
      'opencode2', 'run', '--dir', '/work/repo',
    ], WT, { timeoutMs: 5 });
  });

  it('kills the in-container process when the run is aborted, and only then', async () => {
    const proc = fakeDockerProcess();
    const ac = new AbortController();
    const spawnHeadless = vi.fn().mockImplementation(() => { ac.abort(); return Promise.resolve(OK); });
    const runner = createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined, spawnHeadless, newRunId: () => 'r2' });
    await runner.runHeadless('opencode', [], WT, { signal: ac.signal });
    expect(lines(proc)).toEqual([`docker exec ${names.container} sh -c kill -KILL "$(cat "/tmp/karst-run-$1.pid")" karst-kill r2`]);

    const quiet = fakeDockerProcess();
    const ac2 = new AbortController();
    const done = createDockerSessionRunner({ proc: quiet, core: 'opencode', names, user: undefined, spawnHeadless: vi.fn().mockResolvedValue(OK) });
    await done.runHeadless('opencode', [], WT, { signal: ac2.signal });
    ac2.abort();
    expect(quiet.calls).toHaveLength(0);
  });

  it('generates a safe random run id by default', async () => {
    const spawnHeadless = vi.fn().mockResolvedValue(OK);
    const runner = createDockerSessionRunner({ proc: fakeDockerProcess(), core: 'opencode', names, user: undefined, spawnHeadless });
    await runner.runHeadless('opencode', [], WT);
    expect((spawnHeadless.mock.calls[0]![1] as string[])[9]).toMatch(/^[0-9a-f]{16}$/);
  });

  it('syncs through the bundle transport', async () => {
    const proc = fakeDockerProcess();
    const runner = createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined, temp });
    await expect(runner.sync!(ticket)).resolves.toMatchObject({ ok: true });
    expect(lines(proc).at(-1)).toBe('git -C /w/t7 merge --ff-only FETCH_HEAD');
  });

  it('disposes exactly this ticket\'s container, proxy, network and volumes', async () => {
    const proc = fakeDockerProcess();
    await createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined }).dispose!(ticket);
    expect(lines(proc)).toEqual([
      `docker rm --force ${names.container}`,
      `docker rm --force ${names.proxy}`,
      `docker network rm ${names.network}`,
      `docker volume rm --force ${names.repoVolume} ${names.dataVolume}`,
    ]);
    const touched = proc.calls.flatMap((c) => c.args);
    for (const bystander of Object.values(other)) expect(touched).not.toContain(bystander);
  });
});

describe('permissions under the docker runner (arch:AC-31)', () => {
  it('adds no bypass flag for opencode or opencode2, under docker or on the host', () => {
    const runner = createDockerSessionRunner({ proc: fakeDockerProcess(), core: 'opencode', names, user: undefined });
    for (const core of ['opencode', 'opencode2']) {
      expect(autonomousPermissionArgs(core, runner)).toEqual([]);
      expect(autonomousPermissionArgs(core, HOST_SESSION_RUNNER)).toEqual([]);
    }
  });
});

describe('prepareDockerSandbox', () => {
  const base = { core: 'opencode' as const, names, user: undefined, ticket, proxyScript: '/ext/proxy.mjs', temp };

  it('reuses everything that exists: no create, no clone, no seed', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' } });
    await expect(prepareDockerSandbox({ ...base, proc })).resolves.toEqual({ ok: true });
    expect(lines(proc)).toEqual([
      `docker network inspect ${names.network}`,
      `docker volume inspect ${names.repoVolume}`,
      `docker volume inspect ${names.dataVolume}`,
      `docker container inspect --format {{.State.Running}} ${names.proxy}`,
      expect.stringContaining('git -C /work/repo rev-parse --git-dir'),
    ]);
  });

  it('creates an internal network and fresh volumes, chowning them on linux', async () => {
    const proc = fakeDockerProcess({ 'docker network inspect': { code: 1 }, 'docker volume inspect': { code: 1 }, 'docker container inspect': { stdout: 'true' } });
    await prepareDockerSandbox({ ...base, proc, user: { uid: 1001, gid: 1002 } });
    const l = lines(proc);
    expect(l).toContain(`docker network create --internal ${names.network}`);
    expect(l).toContain(`docker volume create ${names.repoVolume}`);
    expect(l.some((x) => x.includes(`${OPENCODE_IMAGE} chown 1001:1002`))).toBe(true);
  });

  it.each([
    ['docker network inspect', { 'docker network inspect': { code: 1 }, 'docker network create': { code: 1, stderr: 'forbidden' } }, `docker network create ${names.network} failed: forbidden`],
    ['repo volume', { [`docker volume inspect ${names.repoVolume}`]: { code: 1 }, 'docker volume create': { code: 1, stderr: 'full' } }, `docker volume create ${names.repoVolume} failed: full`],
    ['data volume', { [`docker volume inspect ${names.dataVolume}`]: { code: 1 }, 'docker volume create': { code: 1, stderr: 'full' } }, `docker volume create ${names.dataVolume} failed: full`],
    ['proxy', { 'docker container inspect': { code: 1 }, 'docker run --detach': { code: 1, stderr: 'no image' } }, 'proxy sidecar failed to start: no image'],
  ])('fails with the first reason (%s)', async (_label, answers, reason) => {
    const proc = fakeDockerProcess(answers);
    await expect(prepareDockerSandbox({ ...base, proc })).resolves.toEqual({ ok: false, reason });
  });

  it('fails on a linux chown error', async () => {
    const proc = fakeDockerProcess({ 'docker volume inspect': { code: 1 }, 'docker run --rm --network none --user 0': { code: 1, stderr: 'x' } });
    await expect(prepareDockerSandbox({ ...base, proc, user: { uid: 1, gid: 1 } })).resolves.toEqual({ ok: false, reason: 'docker volume chown failed: x' });
  });

  it('fails when the clone fails', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' }, 'docker run --rm --network none': { code: 128 }, 'git -C /w/t7 bundle': { code: 1, stderr: 'bad' } });
    await expect(prepareDockerSandbox({ ...base, proc })).resolves.toEqual({ ok: false, reason: 'git bundle create feat/x failed: bad' });
  });

  it('seeds opencode2 credentials last, and not for opencode v1', async () => {
    const empty = { 'docker container inspect': { stdout: 'true' }, 'docker run --rm --network none': { stdout: 'No authenticated integrations' } };
    const proc = fakeDockerProcess(empty, { fromCode: 1, toCode: 0 });
    const debug = vi.fn();
    const host = { command: 'opencode2', env: {} };
    await expect(prepareDockerSandbox({ ...base, core: 'opencode2', proc, opencode2Host: host, debug })).resolves.toMatchObject({ ok: false });
    expect(debug).toHaveBeenCalled();
    const v1 = fakeDockerProcess(empty);
    await prepareDockerSandbox({ ...base, proc: v1, opencode2Host: host });
    expect(v1.pipes).toHaveLength(0);
    const noHost = fakeDockerProcess(empty);
    await expect(prepareDockerSandbox({ ...base, core: 'opencode2', proc: noHost })).resolves.toEqual({ ok: true });
  });
});
