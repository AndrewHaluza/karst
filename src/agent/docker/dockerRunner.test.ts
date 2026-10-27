import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HeadlessSpawnResult } from '../headlessSpawn.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import { dockerNames } from './dockerNames.js';
import { interactiveRunArgs } from './dockerRunArgs.js';
import { createDockerSessionRunner, prepareDockerSandbox } from './dockerRunner.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';
import { autonomousLaunch } from '../autonomousLaunch.js';
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
    const env = autonomousLaunch('opencode', runner).env(spec.env);
    expect(runner.placeInteractive(spec)).toEqual({
      cwd: WT,
      shellPath: 'docker',
      shellArgs: interactiveRunArgs({ names, core: 'opencode', user: undefined, authFile: '/h/auth.json', hostWorktreePath: WT, args: [WT], env }),
      env,
    });
    expect(env['OPENCODE_PURE']).toBe('0');
    expect(proc.calls).toHaveLength(0);
  });

  it('has no headless entry point: ticket-bound headless runs are host-only (arch:AC-33)', () => {
    const runner = createDockerSessionRunner({ proc: fakeDockerProcess(), core: 'opencode2', names, user: undefined });
    expect(runner.runHeadless).toBeUndefined();
  });

  it('syncs through the bundle transport', async () => {
    const proc = fakeDockerProcess();
    const runner = createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined, temp });
    await expect(runner.sync!(ticket)).resolves.toMatchObject({ ok: true });
    expect(lines(proc).at(-1)).toBe('git -C /w/t7 merge --ff-only FETCH_HEAD');
  });

  it('diffs through the bundle transport without merging', async () => {
    const proc = fakeDockerProcess({ 'git -C /w/t7 diff': { stdout: 'diff --git a/f b/f\n' } });
    const runner = createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined, temp });
    await expect(runner.diff!(ticket)).resolves.toEqual({ ok: true, diff: 'diff --git a/f b/f\n', ref: 'FETCH_HEAD' });
    expect(lines(proc).at(-1)).toBe(`git -C /w/t7 diff HEAD...FETCH_HEAD`);
    expect(lines(proc).some((l) => l.includes('merge'))).toBe(false);
  });

  it('reports a docker diff failure instead of throwing', async () => {
    const proc = fakeDockerProcess({ [`docker run`]: { code: 1, stderr: 'no volume\n' } });
    const runner = createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined, temp });
    await expect(runner.diff!(ticket)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('no sandbox clone') });
  });

  it('stops only this ticket\'s container and proxy, keeping clone and data volumes', async () => {
    const proc = fakeDockerProcess();
    await createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined }).stop!();
    expect(lines(proc)).toEqual([`docker stop ${names.container}`, `docker stop ${names.proxy}`]);
  });

  it('disposes exactly this ticket\'s container, port relays, proxy, network and volumes', async () => {
    const proc = fakeDockerProcess({ 'docker ps --all': { stdout: 'relay1\n' } });
    await createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined }).dispose!(ticket);
    expect(lines(proc)).toEqual([
      `docker rm --force ${names.container} ${names.container}-svc`,
      `docker ps --all --quiet --filter label=karst.relay=${names.container}`,
      'docker rm --force relay1',
      `docker rm --force ${names.proxy}`,
      `docker network rm ${names.network}`,
      `docker volume rm --force ${names.repoVolume} ${names.dataVolume}`,
    ]);
    const touched = proc.calls.flatMap((c) => c.args);
    for (const bystander of Object.values(other)) expect(touched).not.toContain(bystander);
  });
});

describe('docker dispose outcomes', () => {
  it('a failed network rm is failed; a missing container is absent', async () => {
    const proc = fakeDockerProcess({
      'docker rm --force karst': { code: 1, stderr: 'Error: No such container' },
      'docker network rm': { code: 1, stderr: 'network has active endpoints' },
    });
    const result = await createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined }).dispose!(ticket);
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.step === 'container')?.status).toBe('absent');
    expect(result.steps.find((s) => s.step === 'network')).toEqual({ step: 'network', status: 'failed', stderr: 'network has active endpoints' });
  });
});

describe('permissions under the docker runner (arch:AC-31)', () => {
  const spec = { hostWorktreePath: '/wt', args: ['/wt'], env: { OPENCODE_CONFIG_CONTENT: '{"model":"m"}' }, ticketId: 1 } as never;

  it.each(['opencode', 'opencode2'] as const)('%s gets the allow-all config through the container env, no flag', (core) => {
    const runner = createDockerSessionRunner({ proc: fakeDockerProcess(), core, names, user: undefined });
    const placed = runner.placeInteractive(spec);
    const cfg = JSON.parse(placed.env['OPENCODE_CONFIG_CONTENT']!);
    expect(cfg.model).toBe('m');
    expect(cfg.permission.edit).toBe('allow');
    // by name only: the value never lands in the argv
    expect(placed.shellArgs.join(' ')).not.toContain('"allow"');
    expect(placed.shellArgs).toContain('OPENCODE_CONFIG_CONTENT');
    expect(placed.shellArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('the host runner never relaxes opencode in any form', () => {
    for (const core of ['opencode', 'opencode2']) {
      const launch = autonomousLaunch(core, HOST_SESSION_RUNNER);
      expect(launch.args).toEqual([]);
      expect(launch.env({ OPENCODE_CONFIG_CONTENT: '{}' })).toEqual({ OPENCODE_CONFIG_CONTENT: '{}' });
    }
  });
});

describe('prepareDockerSandbox', () => {
  const base = { core: 'opencode' as const, names, user: undefined, ticket, proxyScript: '/ext/proxy.mjs', temp };

  it('starts the proxy with the baseline host ports (arch:AC-32)', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { code: 1 } });
    await prepareDockerSandbox({ ...base, proc, hostPorts: [5432] });
    expect(lines(proc).find((l) => l.startsWith('docker run --detach'))).toContain('ALLOW_HOSTPORTS=host.docker.internal:5432');
  });

  it('reuses everything that exists: no create, no clone, no seed', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' } });
    await expect(prepareDockerSandbox({ ...base, proc })).resolves.toEqual({ ok: true });
    expect(lines(proc)).toEqual([
      `docker network inspect ${names.network}`,
      `docker volume inspect ${names.repoVolume}`,
      `docker volume inspect ${names.dataVolume}`,
      `docker container inspect --format {{.State.Running}} {{index .Config.Labels "karst.hostallow"}} {{index .Config.Labels "karst.allow"}} ${names.proxy}`,
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
    const proc = fakeDockerProcess({ 'docker volume inspect': { code: 1 }, 'docker run --rm --network none --cap-drop ALL --cap-add CHOWN': { code: 1, stderr: 'x' } });
    await expect(prepareDockerSandbox({ ...base, proc, user: { uid: 1, gid: 1 } })).resolves.toEqual({ ok: false, reason: 'docker volume chown failed: x' });
  });

  it('fails when the clone fails, and stops the proxy so no egress stays up', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' }, 'docker run --rm --network none': { code: 128 }, 'git -C /w/t7 bundle': { code: 1, stderr: 'bad' } });
    await expect(prepareDockerSandbox({ ...base, proc })).resolves.toEqual({ ok: false, reason: 'git bundle create feat/x failed: bad' });
    expect(lines(proc).at(-1)).toBe(`docker rm --force ${names.proxy}`);
    expect(lines(proc).some((l) => l.startsWith('docker volume rm'))).toBe(false);
  });

  it('turns a throwing clone (unsafe temp path) into a reason', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' }, 'docker run --rm --network none': { code: 128 } });
    const bad = { make: () => Promise.resolve('/t,x'), remove: () => Promise.resolve() };
    await expect(prepareDockerSandbox({ ...base, proc, temp: bad })).resolves.toEqual({ ok: false, reason: 'docker: unsafe bind path "/t,x"' });
  });

  it('chowns on every linux launch, so an interrupted first chown is retried', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' } });
    await prepareDockerSandbox({ ...base, proc, user: { uid: 1001, gid: 1002 } });
    expect(lines(proc).some((l) => l.includes('chown 1001:1002'))).toBe(true);
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

  it('calls seedAgyCredentials for antigravity when bridgeDir is set', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' } });
    const bridgeDir = mkdtempSync(join(tmpdir(), 'karst-bridge-test-'));
    const result = await prepareDockerSandbox({
      ...base,
      core: 'antigravity',
      proc,
      bridgeDir,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli'))).toBe(true);
    rmSync(bridgeDir, { recursive: true, force: true });
  });

  it('mounts the bridge dir and exposes runDir to the agent', () => {
    const runner = createDockerSessionRunner({ proc: fakeDockerProcess(), core: 'opencode', names, user: undefined, authFile: undefined });
    const spec = { ticketId: 7, hostWorktreePath: WT, command: 'opencode', args: [WT], env: {}, bridgeDir: '/g/events/7' };
    expect(runner.placeInteractive(spec).shellArgs).toContain('type=bind,source=/g/events/7,target=/karst-bridge/7');
    const paths = { dir: '/g/events/7', eventsFile: '/g/events/7/events.ndjson', stateFile: '/g/state/7.json', resultsDir: '/g/events/7/results', inboxDir: '/g/events/7/inbox', pendingFile: '/g/state/7.marker.json', handledFile: '/g/state/7.handled.json', setupStateFile: '/g/state/7.setup.json', setupLogFile: '/g/events/7/logs/setup.log', runDir: '/karst-bridge/7' };
    expect(runner.bridgeRunDir?.(paths)).toBe('/karst-bridge/7');
  });
});

describe('host-only env never enters the container (F2, arch:AC-33)', () => {
  const hostEnv = {
    KARST_CLI: '/h/cli.js', KARST_DB: '/h/db.sqlite', KARST_MANIFEST: '/h/.karst/karst.yml', KARST_INSTRUCTIONS: '/h/i.md',
    KARST_BRIDGE_DIR: '/karst-bridge/7', KARST_TICKET: 'K-7', KARST_TICKET_ID: '7', KARST_LAUNCH_ID: 'l1', KARST_PROVIDER: 'opencode',
  };
  it('drops the host-path vars from the placed env and from the docker --env flags', () => {
    const runner = createDockerSessionRunner({ proc: fakeDockerProcess(), core: 'opencode', names, user: undefined, authFile: '/h/auth.json', temp });
    const placed = runner.placeInteractive({ ticketId: 7, hostWorktreePath: WT, command: 'opencode', args: [WT], env: hostEnv });
    for (const k of ['KARST_CLI', 'KARST_DB', 'KARST_MANIFEST', 'KARST_INSTRUCTIONS']) {
      expect(placed.env).not.toHaveProperty(k);
      expect(placed.shellArgs).not.toContain(k);
    }
    for (const k of ['KARST_BRIDGE_DIR', 'KARST_TICKET', 'KARST_TICKET_ID', 'KARST_LAUNCH_ID', 'KARST_PROVIDER']) expect(placed.env).toHaveProperty(k);
  });
});

describe('createDockerSessionRunner.probeSandbox (arch:AC-39)', () => {
  it('present on exit 0, absent only on "No such volume", unknown otherwise', async () => {
    const mk = (answer: { code: number; stderr?: string }) => createDockerSessionRunner({ proc: fakeDockerProcess({ 'docker volume inspect': answer }), core: 'opencode', names: dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' }), user: undefined });
    await expect(mk({ code: 0 }).probeSandbox!()).resolves.toEqual({ state: 'present' });
    await expect(mk({ code: 1, stderr: 'Error: No such volume: x' }).probeSandbox!()).resolves.toEqual({ state: 'absent' });
    await expect(mk({ code: 127, stderr: 'spawn docker ENOENT' }).probeSandbox!()).resolves.toMatchObject({ state: 'unknown', reason: expect.stringContaining('not found on the PATH') });
    await expect(mk({ code: 1, stderr: 'Cannot connect to the Docker daemon' }).probeSandbox!()).resolves.toMatchObject({ state: 'unknown' });
    await expect(mk({ code: 1, stderr: 'Cannot connect' }).hasSandbox!()).resolves.toBe(false);
  });
});
