import { describe, expect, it } from 'vitest';
import { fakeDockerProcess } from '../docker/fakeDockerProcess.js';
import { dockerNames } from '../docker/dockerNames.js';
import { OPENCODE_IMAGE } from '../docker/dockerImage.js';
import { PROXY_PORT } from '../docker/allowlistProxy.js';
import { PROXY_ALIAS } from '../docker/proxySidecar.js';
import { EGRESS_PROBE_OK, EGRESS_PROBE_SCRIPT, probeSshDockerEgress } from './sshDockerEgress.js';

const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' });
const USER = { uid: 1000, gid: 1001 };

describe('probeSshDockerEgress', () => {
  it('passes only on exit 0 AND the exact marker', async () => {
    const proc = fakeDockerProcess({ 'docker run --rm': { code: 0, stdout: `${EGRESS_PROBE_OK}\n` } });
    await expect(probeSshDockerEgress(proc, names, USER)).resolves.toEqual({ ok: true });
  });

  it('fails on a non-zero exit, naming the check that failed', async () => {
    const ipv4 = fakeDockerProcess({ 'docker run --rm': { code: 1, stdout: 'direct IPv4 egress succeeded\n' } });
    await expect(probeSshDockerEgress(ipv4, names, USER)).resolves.toEqual({ ok: false, reason: 'direct IPv4 egress succeeded' });
    const ipv6 = fakeDockerProcess({ 'docker run --rm': { code: 1, stdout: 'direct IPv6 egress succeeded\n' } });
    await expect(probeSshDockerEgress(ipv6, names, USER)).resolves.toEqual({ ok: false, reason: 'direct IPv6 egress succeeded' });
    const proxy = fakeDockerProcess({ 'docker run --rm': { code: 1, stdout: 'proxy did not refuse blocked host\n' } });
    await expect(probeSshDockerEgress(proxy, names, USER)).resolves.toEqual({ ok: false, reason: 'proxy did not refuse blocked host' });
  });

  it('fails when the probe exits non-zero with no reason (falls back to stderr)', async () => {
    const proc = fakeDockerProcess({ 'docker run --rm': { code: 2, stderr: 'docker: image not found\n' } });
    await expect(probeSshDockerEgress(proc, names, USER)).resolves.toEqual({ ok: false, reason: 'docker: image not found' });
  });

  it('fails on exit 0 with no marker: a probe that printed nothing proved nothing', async () => {
    const proc = fakeDockerProcess({ 'docker run --rm': { code: 0, stdout: 'ok\n' } });
    await expect(probeSshDockerEgress(proc, names, USER)).resolves.toEqual({
      ok: false, reason: `the probe printed no ${EGRESS_PROBE_OK} marker`,
    });
  });

  it('fails on a transport drop (255): the daemon was never reached', async () => {
    const proc = fakeDockerProcess({ 'docker run --rm': { code: 255, stdout: EGRESS_PROBE_OK, transport: true, stderr: 'ssh: connect\n' } });
    await expect(probeSshDockerEgress(proc, names, USER)).resolves.toMatchObject({
      ok: false, reason: expect.stringContaining('did not reach the remote daemon'),
    });
  });

  it('runs one hardened one-shot container on the ticket network, as the remote uid, never privileged', async () => {
    const proc = fakeDockerProcess({ 'docker run --rm': { code: 0, stdout: `${EGRESS_PROBE_OK}\n` } });
    await probeSshDockerEgress(proc, names, USER);
    expect(proc.calls).toHaveLength(1);
    const args = proc.calls[0]!.args;
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--network', names.network]);
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']));
    expect(args).toEqual(expect.arrayContaining(['--user', '1000:1001']));
    expect(args.slice(-4)).toEqual([OPENCODE_IMAGE, 'node', '-e', EGRESS_PROBE_SCRIPT]);
    expect(args).not.toContain('--privileged');
    expect(args.join(' ')).not.toContain('docker.sock');
  });

  it('omits the user flags without a remote uid (Docker Desktop semantics are not assumed)', async () => {
    const proc = fakeDockerProcess({ 'docker run --rm': { code: 0, stdout: `${EGRESS_PROBE_OK}\n` } });
    await probeSshDockerEgress(proc, names, undefined);
    expect(proc.calls[0]!.args).not.toContain('--user');
  });
});

describe('EGRESS_PROBE_SCRIPT', () => {
  it('checks both address families, then the proxy refusal, then prints the marker', () => {
    expect(EGRESS_PROBE_SCRIPT).toContain('1.1.1.1');
    expect(EGRESS_PROBE_SCRIPT).toContain('2606:4700:4700::1111');
    expect(EGRESS_PROBE_SCRIPT).toContain(`host: '${PROXY_ALIAS}', port: ${String(PROXY_PORT)}`);
    expect(EGRESS_PROBE_SCRIPT).toContain('blocked.invalid');
    expect(EGRESS_PROBE_SCRIPT).toContain('403');
    expect(EGRESS_PROBE_SCRIPT).toContain(`process.stdout.write('${EGRESS_PROBE_OK}`);
    // Order: both direct checks first, the proxy last, the marker only after.
    expect(EGRESS_PROBE_SCRIPT.indexOf('direct IPv4')).toBeLessThan(EGRESS_PROBE_SCRIPT.indexOf('proxy did not refuse'));
    expect(EGRESS_PROBE_SCRIPT.indexOf('proxy did not refuse')).toBeLessThan(EGRESS_PROBE_SCRIPT.indexOf(EGRESS_PROBE_OK));
  });

  it('refuses a direct IPv6 connect before it ever asks the proxy', () => {
    const script = EGRESS_PROBE_SCRIPT;
    expect(script.indexOf('connects(\'1.1.1.1\'')).toBeLessThan(script.indexOf('connects(\'2606:4700:4700::1111\''));
    expect(script.indexOf('connects(\'2606:4700:4700::1111\'')).toBeLessThan(script.indexOf('const proxy = await proxyRefusal()'));
  });
});
