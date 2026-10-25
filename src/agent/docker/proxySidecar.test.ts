import { describe, expect, it } from 'vitest';
import { SANDBOX_NETWORK_ALLOWLIST } from '../sandbox.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';
import { DOCKER_ALLOWLIST, haltProxySidecar, PROXY_MEMORY_LIMIT, PROXY_MEMORY_RESERVATION, PROXY_URL, sidecarRunArgs, startProxySidecar, stopProxySidecar } from './proxySidecar.js';

const SPEC = { proxy: 'k-proxy', network: 'k-net', scriptPath: '/ext dir/allowlist-proxy.mjs' };
const lines = (proc: ReturnType<typeof fakeDockerProcess>) => proc.calls.map((c) => [c.command, ...c.args].join(' '));

describe('proxySidecar', () => {
  it('allowlists the ST1 domains plus the opencode providers', () => {
    expect(DOCKER_ALLOWLIST).toEqual([...SANDBOX_NETWORK_ALLOWLIST, 'opencode.ai', 'openrouter.ai', 'models.dev']);
    expect(PROXY_URL).toBe('http://karst-proxy:3128');
  });

  it('runs the proxy unprivileged on the ticket network with the script read-only', () => {
    const args = sidecarRunArgs({ ...SPEC, allow: ['a.io', 'b.io'] });
    expect(args).toEqual([
      'run', '--detach', '--name', 'k-proxy',
      '--network', 'k-net', '--network-alias', 'karst-proxy',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '128m', '--memory-reservation', '64m',
      '--env', 'ALLOW=a.io,b.io', '--label', 'karst.allow=a.io,b.io',
      '--mount', 'type=bind,source=/ext dir/allowlist-proxy.mjs,target=/opt/karst/allowlist-proxy.mjs,readonly',
      OPENCODE_IMAGE, 'node', '/opt/karst/allowlist-proxy.mjs',
    ]);
    expect(args.join(' ')).not.toMatch(/privileged|docker\.sock/);
  });

  it('defaults to the docker allowlist', () => {
    expect(sidecarRunArgs(SPEC)).toContain(`ALLOW=${DOCKER_ALLOWLIST.join(',')}`);
  });

  it('starts a missing proxy and connects only it to the bridge', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { code: 1 } });
    await expect(startProxySidecar(proc, SPEC)).resolves.toEqual({ ok: true });
    expect(lines(proc).slice(1)).toEqual([
      ['docker', ...sidecarRunArgs(SPEC)].join(' '),
      'docker network connect bridge k-proxy',
    ]);
  });

  it('keeps a running proxy', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true\n' } });
    await expect(startProxySidecar(proc, SPEC)).resolves.toEqual({ ok: true });
    expect(proc.calls).toHaveLength(1);
  });

  it('replaces a stopped proxy', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'false\n' } });
    await startProxySidecar(proc, SPEC);
    expect(lines(proc)[1]).toBe('docker rm --force k-proxy');
    expect(lines(proc)[2]).toMatch(/^docker run --detach/);
  });

  it('reports a failed start', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { code: 1 }, 'docker run': { code: 125, stderr: 'no such network' } });
    await expect(startProxySidecar(proc, SPEC)).resolves.toEqual({ ok: false, reason: 'proxy sidecar failed to start: no such network' });
  });

  it('removes the proxy again when it cannot get egress', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { code: 1 }, 'docker network connect': { code: 1, stderr: 'denied' } });
    await expect(startProxySidecar(proc, SPEC)).resolves.toEqual({ ok: false, reason: 'proxy sidecar has no egress network: denied' });
    expect(lines(proc).at(-1)).toBe('docker rm --force k-proxy');
  });

  it('stops by exact name', async () => {
    const proc = fakeDockerProcess();
    await stopProxySidecar(proc, 'k-proxy');
    expect(lines(proc)).toEqual(['docker rm --force k-proxy']);
  });
});

describe('proxy sidecar: baseline host ports (arch:AC-32)', () => {
  it('passes exactly the declared host ports and maps host.docker.internal for the proxy only', () => {
    const args = sidecarRunArgs({ proxy: 'p', network: 'n', scriptPath: '/s.mjs', hostPorts: [5432, 6379] });
    const v = 'host.docker.internal:5432,host.docker.internal:6379';
    expect(args).toEqual(expect.arrayContaining([`ALLOW_HOSTPORTS=${v}`, `karst.hostallow=${v}`, 'host.docker.internal:host-gateway']));
    expect(sidecarRunArgs({ proxy: 'p', network: 'n', scriptPath: '/s.mjs' }).join(' ')).not.toMatch(/HOSTPORTS|host-gateway|hostallow/);
  });

  it('recreates a running proxy whose baseline ports differ, keeps one that matches', async () => {
    const stale = fakeDockerProcess({ 'docker container inspect': { stdout: 'true <no value>\n' } });
    await startProxySidecar(stale, { proxy: 'p', network: 'n', scriptPath: '/s.mjs', hostPorts: [5432] });
    expect(stale.calls.map((c) => c.args[0])).toEqual(['container', 'rm', 'run', 'network']);
    const same = fakeDockerProcess({ 'docker container inspect': { stdout: 'true host.docker.internal:5432\n' } });
    await startProxySidecar(same, { proxy: 'p', network: 'n', scriptPath: '/s.mjs', hostPorts: [5432] });
    expect(same.calls).toHaveLength(1);
  });

  it('caps the proxy memory', () => {
    expect([PROXY_MEMORY_LIMIT, PROXY_MEMORY_RESERVATION]).toEqual(['128m', '64m']);
  });

  it('halts (not removes) the proxy, tolerating a gone container', async () => {
    const proc = fakeDockerProcess();
    await expect(haltProxySidecar(proc, 'k-proxy')).resolves.toEqual({ ok: true });
    expect(lines(proc)).toEqual(['docker stop k-proxy']);
    const gone = fakeDockerProcess({ 'docker stop': { code: 1, stderr: 'Error: No such container: k-proxy' } });
    await expect(haltProxySidecar(gone, 'k-proxy')).resolves.toEqual({ ok: true });
    const bad = fakeDockerProcess({ 'docker stop': { code: 1, stderr: 'daemon down' } });
    await expect(haltProxySidecar(bad, 'k-proxy')).resolves.toMatchObject({ ok: false });
  });
});
