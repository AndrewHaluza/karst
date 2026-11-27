import { describe, expect, it, vi } from 'vitest';
import { NODE_DOCKER_PROCESS } from '../../agent/docker/dockerProcess.js';
import { remoteTrustKey } from '../../agent/ssh/remoteTrust.js';
import { fakeSshProcess, type FakeSshAnswer, type FakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { sshControlDir } from '../../agent/ssh/sshControlDir.js';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { createSshGateRegistry, sshGateKey } from '../../agent/ssh/sshGateRegistry.js';
import { sshProjectPrefix } from '../../agent/ssh/sshNames.js';
import type { RemoteDef } from '../../manifest/types.js';
import type { TicketPlacement } from '../../store/placement.js';
import { FAKE_INSTALL_ID, FAKE_REMOTE, fakeSshDockerRunnerDeps, fakeSshPlacement, fakeSshRunnerDeps, fakeTrustDir } from './fakeSshRunnerDeps.js';
import { sshDockerKillContextFor, sshRunnerFor, parseRemoteUser, SSH_DEPS_MISSING, type SshRunnerDeps, type SshRunnerTicket } from './sshRunnerFor.js';

const REMOTE = FAKE_REMOTE;
const PLACEMENT = fakeSshPlacement();
const TICKET: SshRunnerTicket = { ticketId: 7, projectRoot: '/p', hostWorktreePath: '/wt' };
const REF = { hostWorktreePath: '/wt', branch: 'k/b' };
const trustDir = fakeTrustDir;
const sshDeps = fakeSshRunnerDeps;

/**
 * The remote script as the remote shell parses it: `sh -c 'docker '\''volume'\'' …'`
 * loses the ssh quoting, so an assertion reads `docker volume inspect …`.
 */
function remoteScript(args: readonly string[]): string {
  return (args.at(-1) ?? '').replaceAll(`'\\''`, "'").replaceAll("'", '').replace(/^sh -c /, '');
}

function untouched(ssh: FakeSshProcess): void {
  expect(ssh.calls).toEqual([]);
  expect(ssh.stdinCalls).toEqual([]);
  expect(ssh.pipes).toEqual([]);
  expect(ssh.streams).toEqual([]);
}

async function expectRefused(deps: SshRunnerDeps | undefined, reason: string, placement: TicketPlacement = PLACEMENT, ticket = TICKET): Promise<void> {
  const gate = vi.fn();
  const runner = sshRunnerFor(deps === undefined ? undefined : { ...deps, gateProcess: gate }, placement, ticket);
  expect(runner.kind).toBe('ssh');
  expect(await runner.probeSandbox!()).toEqual({ state: 'unknown', reason });
  expect(await runner.sync!(REF)).toEqual({ ok: false, reason });
  expect(await runner.runGate!('true', [], '/wt')).toMatchObject({ kind: 'spawnFailed', message: reason });
  expect((await runner.dispose!(REF)).ok).toBe(false);
  expect(gate).not.toHaveBeenCalled();
}

describe('sshRunnerFor (D826)', () => {
  it('parseRemoteUser reads exactly two decimal lines and nothing else', () => {
    expect(parseRemoteUser('1001\n1002\n')).toEqual({ uid: 1001, gid: 1002 });
    expect(parseRemoteUser('1001\n1002')).toEqual({ uid: 1001, gid: 1002 });
    expect(parseRemoteUser('0\n0\n')).toEqual({ uid: 0, gid: 0 });
    expect(parseRemoteUser('1001\n')).toBeUndefined();
    expect(parseRemoteUser('')).toBeUndefined();
    expect(parseRemoteUser('uid=1001\n1002\n')).toBeUndefined();
    expect(parseRemoteUser('1001\ngid=1002\n')).toBeUndefined();
    expect(parseRemoteUser(' 1001\n1002\n')).toBeUndefined();
    expect(parseRemoteUser('1001\n1002\nextra\n')).toBeUndefined();
  });

  it('builds the ssh runner of a trusted direct remote: the probe runs over ssh', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-probe': { code: 0 } });
    const runner = sshRunnerFor(sshDeps(ssh), PLACEMENT, TICKET);
    expect(runner.kind).toBe('ssh');
    expect(await runner.probeSandbox!()).toEqual({ state: 'present' });
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0]!.args).toContain('karst@vm.example.com');
    expect(ssh.calls[0]!.args.join(' ')).toContain('ControlPath=/tmp/karst-ssh-test/');
  });

  it('a remote that is not in karst.yml refuses with no ssh call', async () => {
    const ssh = fakeSshProcess();
    await expectRefused(sshDeps(ssh, { remotes: () => ({}) }), 'ssh remote devbox not in karst.yml');
    untouched(ssh);
  });

  it('a remote with no trust entry refuses sync, runGate and dispose with no ssh call', async () => {
    const ssh = fakeSshProcess();
    await expectRefused(sshDeps(ssh, { globalStorageDir: trustDir({}) }), 'ssh remote devbox not confirmed');
    untouched(ssh);
  });

  it.each([
    ['host', { host: 'other.example.com' }], ['port', { port: 2222 }], ['user', { user: 'root' }], ['keyPath', { keyPath: '/k' }],
    ['mode', { mode: 'docker' as const }], ['remoteDir', { remoteDir: '/srv/x' }], ['allowHostServices', { allowHostServices: true }],
  ])('a changed %s makes the stored hash stale: not confirmed, no ssh call', async (_field, change) => {
    const ssh = fakeSshProcess();
    await expectRefused(sshDeps(ssh, { remotes: () => ({ devbox: { ...REMOTE, ...change } }) }), 'ssh remote devbox not confirmed');
    untouched(ssh);
  });

  it('a trust entry of another name does not confirm this remote', async () => {
    const ssh = fakeSshProcess();
    await expectRefused(sshDeps(ssh, { globalStorageDir: trustDir({ other: remoteTrustKey('devbox', REMOTE) }) }), 'ssh remote devbox not confirmed');
    untouched(ssh);
  });

  it('builds the ssh docker runner of a trusted docker-mode remote (D822): every docker call runs over ssh', async () => {
    const ssh = fakeSshProcess();
    const localRun = vi.spyOn(NODE_DOCKER_PROCESS, 'run');
    try {
      const runner = sshRunnerFor(fakeSshDockerRunnerDeps(ssh), fakeSshPlacement(7, 'opencode'), TICKET);
      expect(runner.kind).toBe('ssh');
      expect(runner.enforcesSandbox).toBe(true);
      expect(runner.windowNeedsIdle).toBe(true);
      expect(await runner.probeSandbox!()).toEqual({ state: 'present' });
      expect(localRun).not.toHaveBeenCalled();
      const scripts = ssh.calls.map((c) => remoteScript(c.args));
      expect(scripts).toHaveLength(1);
      // `sh -c 'docker volume inspect …'` on the REMOTE, on the install-id-salted volume.
      expect(ssh.calls[0]!.args.at(-1)!.startsWith("sh -c 'docker ")).toBe(true);
      expect(scripts[0]).toContain('docker volume inspect');
      expect(scripts[0]).toContain(`${sshProjectPrefix('/p', FAKE_INSTALL_ID)}-7-opencode-repo`);
      expect(ssh.calls[0]!.args.join(' ')).toContain('ControlPath=/tmp/karst-ssh-test/');
    } finally {
      localRun.mockRestore();
    }
  });

  it('the docker runner gates and opens its setup window over ssh (never a local docker)', async () => {
    const ssh = fakeSshProcess({ '{{.State.Running}}': { code: 0, stdout: 'true\n' } });
    const gate = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: 'ok' }));
    const runner = sshRunnerFor({ ...fakeSshDockerRunnerDeps(ssh), gateProcess: gate }, fakeSshPlacement(7, 'opencode2'), TICKET);
    await runner.runGate!('npm', ['test'], '/wt');
    // The gate wrapper is a local `ssh` process; the container work happens on the remote daemon.
    expect((gate.mock.calls[0] as unknown[])[0]).toBe('ssh');
    const gateScript = remoteScript((gate.mock.calls[0] as unknown[])[1] as string[]);
    expect(gateScript).toContain('docker exec');
    expect(gateScript).toContain(`${sshProjectPrefix('/p', FAKE_INSTALL_ID)}-7-opencode2`);
    expect(await runner.setupWindow!(['registry.npmjs.org'])).toMatchObject({ ok: true });
    const scripts = ssh.calls.map((c) => remoteScript(c.args));
    expect(scripts.some((s) => s.includes('docker run'))).toBe(true);
    expect(ssh.calls.every((c) => (c.args.at(-1) ?? '').startsWith('sh -c '))).toBe(true);
  });

  it('a one-shot docker gate keeps the ticket memory limits over ssh', async () => {
    const ssh = fakeSshProcess({ '{{.State.Running}}': { code: 1 } });
    const gate = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: 'ok' }));
    const runner = sshRunnerFor(
      { ...fakeSshDockerRunnerDeps(ssh), gateProcess: gate },
      fakeSshPlacement(7, 'opencode'),
      { ...TICKET, sandboxMemory: { gateMemory: '512m' } },
    );
    await runner.runGate!('npm', ['test'], '/wt');
    const gateScript = remoteScript((gate.mock.calls[0] as unknown[])[1] as string[]);
    expect(gateScript).toContain('docker run');
    expect(gateScript).toContain('--memory 512m');
  });

  it('the docker runner runs host git through the injected host process, never the real one', async () => {
    const ssh = fakeSshProcess({ '# karst-ssh-docker-thin-bundle': { stdout: 'bundle-bytes' } });
    const host = fakeSbxProcess();
    const runner = sshRunnerFor({ ...fakeSshDockerRunnerDeps(ssh), host }, fakeSshPlacement(7, 'opencode'), TICKET);
    await runner.sync!(REF);
    // The bundle comes off the remote daemon, but the fetch/merge runs on THIS host (D554 Part D).
    expect(host.calls.some((c) => c.command === 'git' && c.args.join(' ').includes('refs/karst/sandbox/'))).toBe(true);
  });

  it('passes debug through to the docker runner', async () => {
    const ssh = fakeSshProcess();
    const debug = vi.fn();
    const gate = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: '' }));
    const runner = sshRunnerFor({ ...fakeSshDockerRunnerDeps(ssh), gateProcess: gate, debug }, fakeSshPlacement(7, 'opencode'), TICKET);
    await runner.runGate!('npm', ['test'], '/wt');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('exit file unreadable'));
  });

  it('a host-step container that writes the volume runs as the REMOTE uid/gid, probed once', async () => {
    const ssh = fakeSshProcess({ '# karst-ssh-docker-user': { stdout: '1001\n1002\n' }, '{{.State.Running}}': { code: 1 } });
    const gate = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: '' }));
    const runner = sshRunnerFor({ ...fakeSshDockerRunnerDeps(ssh), gateProcess: gate }, fakeSshPlacement(7, 'opencode'), TICKET);
    await runner.runGate!('npm', ['test'], '/wt');
    // The one-shot gate container writes the clone volume, which the launch chowned to the remote user.
    expect(remoteScript((gate.mock.calls.at(-1) as unknown[])[1] as string[])).toContain('--user 1001:1002');
    // The service probe container is created with the same user.
    await runner.canHostServices!();
    const serviceRun = ssh.calls.map((c) => remoteScript(c.args)).find((s) => s.includes('sleep infinity'));
    expect(serviceRun).toContain('--user 1001:1002');
    // One probe, not one per op.
    expect(ssh.calls.filter((c) => String(c.args.at(-1)).includes('# karst-ssh-docker-user'))).toHaveLength(1);
    // The probe reads two ids, so it is bounded like every other remote read.
    const probe = ssh.calls.find((c) => String(c.args.at(-1)).includes('# karst-ssh-docker-user'))!;
    expect(probe.opts?.maxStdoutBytes).toBe(1024);
  });

  it('a uid probe that never reached the remote keeps the image user', async () => {
    const ssh = fakeSshProcess({ '# karst-ssh-docker-user': { code: 255, transport: true, stderr: 'down\n', stdout: '1001\n1002\n' }, '{{.State.Running}}': { code: 1 } });
    const gate = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: '' }));
    const runner = sshRunnerFor({ ...fakeSshDockerRunnerDeps(ssh), gateProcess: gate }, fakeSshPlacement(7, 'opencode'), TICKET);
    await runner.runGate!('npm', ['test'], '/wt');
    // Its stdout is never parsed: a drop is no user, even with a plausible body.
    expect(remoteScript((gate.mock.calls.at(-1) as unknown[])[1] as string[])).not.toContain('--user');
  });

  it.each<[string, FakeSshAnswer]>([
    ['a transport flag wins over a 0 exit', { code: 0, transport: true as const, stdout: '1001\n1002\n' }],
    ['a non-zero exit', { code: 7, stdout: '1001\n1002\n' }],
    ['one line', { stdout: '1001\n' }],
    ['a banner first', { stdout: 'uid=1001\n1002\n' }],
    ['a banner second', { stdout: '1001\ngid=1002\n' }],
    ['an empty body', {}],
  ])('a uid probe with %s is no user, never NaN', async (_label, answer) => {
    const ssh = fakeSshProcess({ '# karst-ssh-docker-user': answer, '{{.State.Running}}': { code: 1 } });
    const gate = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: '' }));
    const runner = sshRunnerFor({ ...fakeSshDockerRunnerDeps(ssh), gateProcess: gate }, fakeSshPlacement(7, 'opencode'), TICKET);
    await runner.runGate!('npm', ['test'], '/wt');
    const script = remoteScript((gate.mock.calls.at(-1) as unknown[])[1] as string[]);
    expect(script).not.toContain('--user');
    expect(script).not.toContain('NaN');
  });

  it('a failed uid probe keeps the image user, never this host\'s ids', async () => {
    const ssh = fakeSshProcess({ '# karst-ssh-docker-user': { code: 1 }, '{{.State.Running}}': { code: 1 } });
    const gate = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: '' }));
    const runner = sshRunnerFor({ ...fakeSshDockerRunnerDeps(ssh), gateProcess: gate }, fakeSshPlacement(7, 'opencode'), TICKET);
    await runner.runGate!('npm', ['test'], '/wt');
    expect(remoteScript((gate.mock.calls.at(-1) as unknown[])[1] as string[])).not.toContain('--user');
  });

  it('a throwing uid probe is ignored: the container keeps the image user', async () => {
    const ssh = fakeSshProcess({ '{{.State.Running}}': { code: 1 } });
    const run = ssh.run;
    ssh.run = (args, opts) => (String(args.at(-1)).includes('# karst-ssh-docker-user') ? Promise.reject(new Error('ssh: transport dropped')) : run(args, opts));
    const gate = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: '' }));
    const runner = sshRunnerFor({ ...fakeSshDockerRunnerDeps(ssh), gateProcess: gate }, fakeSshPlacement(7, 'opencode'), TICKET);
    await runner.runGate!('npm', ['test'], '/wt');
    expect(remoteScript((gate.mock.calls.at(-1) as unknown[])[1] as string[])).not.toContain('--user');
  });

  it.each([['claude'], ['codex'], ['agy'], ['']])('a docker-mode remote refuses the core %j without an ssh call', async (core) => {
    const ssh = fakeSshProcess();
    const runner = sshRunnerFor(fakeSshDockerRunnerDeps(ssh), { ...fakeSshPlacement(7, 'opencode'), core }, TICKET);
    const reason = `${core === '' ? 'no core' : core}: ssh docker mode supports only opencode, opencode2`;
    expect(await runner.probeSandbox!()).toEqual({ state: 'unknown', reason });
    untouched(ssh);
  });

  it('an unconfirmed docker-mode remote refuses with zero ssh calls', async () => {
    const ssh = fakeSshProcess();
    const runner = sshRunnerFor(
      { ...fakeSshDockerRunnerDeps(ssh), globalStorageDir: trustDir({}) },
      fakeSshPlacement(7, 'opencode'),
      TICKET,
    );
    expect(await runner.probeSandbox!()).toEqual({ state: 'unknown', reason: 'ssh remote devbox not confirmed' });
    expect(await runner.setupWindow!(['registry.npmjs.org'])).toEqual({ ok: false, reason: 'ssh remote devbox not confirmed' });
    untouched(ssh);
  });

  it('an unsafe control dir refuses every docker remote op, with zero ssh calls', async () => {
    const ssh = fakeSshProcess();
    const reason = 'ssh: control dir /c is not private';
    const runner = sshRunnerFor({ ...fakeSshDockerRunnerDeps(ssh), ensureControlDir: async () => ({ ok: false as const, reason }) }, fakeSshPlacement(7, 'opencode'), TICKET);
    expect(await runner.setupWindow!(['registry.npmjs.org'])).toEqual({ ok: false, reason });
    expect(await runner.canHostServices!()).toBe(false);
    expect(await runner.stopServices!()).toBeUndefined();
    expect(await runner.publishPort!({ hostPort: 3000, sandboxPort: 3000 })).toEqual({ ok: false, reason, portTaken: false });
    expect(await runner.unpublishPort!({ hostPort: 3000, sandboxPort: 3000 })).toBeUndefined();
    expect(await runner.listPorts!()).toBeNull();
    expect(await runner.allowHostPorts!([3000])).toEqual({ ok: false, reason });
    await expect(runner.writeServiceEnv!('svc', { A: '1' })).rejects.toThrow(reason);
    expect(await runner.removeServiceEnv!('svc')).toBeUndefined();
    expect(await runner.runGate!('true', [], '/wt')).toMatchObject({ kind: 'spawnFailed', message: reason });
    untouched(ssh);
  });

  it('sshDockerKillContextFor reads the remote daemon only for a trusted docker-mode placement', async () => {
    const ssh = fakeSshProcess({
      '{{.MemTotal}}': { code: 0, stdout: `${String(8 * 2 ** 30)}\n` },
      '{{.Names}} {{.Image}}': { code: 0, stdout: 'karst-abcd1234-7-opencode karst/opencode-sandbox\n' },
    });
    const kill = sshDockerKillContextFor(fakeSshDockerRunnerDeps(ssh), fakeSshPlacement(7, 'opencode'));
    expect(kill).toBeDefined();
    expect(await kill!()).toBe('Docker VM 8.0 GB, 1 karst/playwright container running');
    const scripts = ssh.calls.map((c) => remoteScript(c.args));
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('docker info');
    expect(scripts[1]).toContain('docker ps');
    // The check's own dir, not a default: it is the same ControlMaster the rest of the ticket uses.
    expect(ssh.calls.every((c) => c.args.join(' ').includes('ControlPath=/tmp/karst-ssh-test/'))).toBe(true);

    const unsafe = vi.fn(async () => ({ ok: false as const, reason: 'ssh: control dir /c is not private' }));
    const blockedDebug = vi.fn();
    const blocked = sshDockerKillContextFor({ ...fakeSshDockerRunnerDeps(ssh), ensureControlDir: unsafe, debug: blockedDebug }, fakeSshPlacement(7, 'opencode'));
    expect(await blocked!()).toBeUndefined();
    expect(blockedDebug).toHaveBeenCalledWith(expect.stringContaining('ssh: control dir /c is not private'));
    expect(ssh.calls).toHaveLength(2);
    // No debug callback: the refusal is still silent, never a throw.
    const blockedNoDebug = sshDockerKillContextFor({ ...fakeSshDockerRunnerDeps(ssh), ensureControlDir: unsafe }, fakeSshPlacement(7, 'opencode'));
    expect(await blockedNoDebug!()).toBeUndefined();

    const throwing = vi.fn(async (): Promise<never> => { throw new Error('ssh: control dir unreadable'); });
    const failedDebug = vi.fn();
    const failed = sshDockerKillContextFor({ ...fakeSshDockerRunnerDeps(ssh), ensureControlDir: throwing, debug: failedDebug }, fakeSshPlacement(7, 'opencode'));
    expect(await failed!()).toBeUndefined();
    // A throwing check keeps its reason in the trace (a decision point, @arch:DBG-03).
    expect(failedDebug).toHaveBeenCalledWith(expect.stringContaining('ssh: control dir unreadable'));
    expect(ssh.calls).toHaveLength(2);
  });

  it('sshDockerKillContextFor checks the default control dir when deps name none', async () => {
    const ssh = fakeSshProcess();
    const seen = vi.fn(async () => ({ ok: true as const }));
    const kill = sshDockerKillContextFor(
      { ...fakeSshDockerRunnerDeps(ssh), controlDir: undefined, ensureControlDir: seen },
      fakeSshPlacement(7, 'opencode'),
    );
    await kill!();
    expect(seen).toHaveBeenCalledWith(sshControlDir());
    expect(ssh.calls.every((c) => c.args.join(' ').includes(`ControlPath=${sshControlDir()}`))).toBe(true);
  });

  it('sshDockerKillContextFor is undefined, with zero ssh calls, for every other placement or remote', async () => {
    const ssh = fakeSshProcess();
    const direct = fakeSshPlacement(7, 'claude');
    // `dockerDeps` defines `devbox` as `mode: docker`; this placement needs a DIRECT remote.
    expect(sshDockerKillContextFor(sshDeps(ssh), direct)).toBeUndefined();
    expect(sshDockerKillContextFor(fakeSshDockerRunnerDeps(ssh), { ...direct, backend: 'sbx' })).toBeUndefined();
    expect(sshDockerKillContextFor(fakeSshDockerRunnerDeps(ssh), null)).toBeUndefined();
    expect(sshDockerKillContextFor(undefined, fakeSshPlacement(7, 'opencode'))).toBeUndefined();
    expect(sshDockerKillContextFor({ ...fakeSshDockerRunnerDeps(ssh), remotes: () => ({}) }, fakeSshPlacement(7, 'opencode'))).toBeUndefined();
    expect(sshDockerKillContextFor({ ...fakeSshDockerRunnerDeps(ssh), remotes: () => undefined }, fakeSshPlacement(7, 'opencode'))).toBeUndefined();
    expect(sshDockerKillContextFor({ ...fakeSshDockerRunnerDeps(ssh), globalStorageDir: trustDir({}) }, fakeSshPlacement(7, 'opencode'))).toBeUndefined();
    untouched(ssh);
  });

  it('refuses without the install id, without deps, without a worktree, a bad core or a bad name', async () => {
    const ssh = fakeSshProcess();
    await expectRefused(sshDeps(ssh, { installId: () => undefined }), 'ssh: the karst install id is not available');
    await expectRefused(undefined, SSH_DEPS_MISSING);
    await expectRefused(sshDeps(ssh), 'ssh: ticket 7 has no worktree', PLACEMENT, { ...TICKET, hostWorktreePath: undefined as string | undefined });
    await expectRefused(sshDeps(ssh), 'agy: ssh backend unsupported', { ...PLACEMENT, core: 'agy' });
    await expectRefused(sshDeps(ssh), 'ssh: invalid sandbox name "Bad Name"', { ...PLACEMENT, sandboxName: 'devbox/Bad Name' });
    await expectRefused(sshDeps(ssh), 'ssh placement of ticket 7 names no <remote>/<name>', { ...PLACEMENT, sandboxName: null });
    await expectRefused(sshDeps(ssh, { remotes: () => undefined }), 'ssh remote devbox not in karst.yml');
    await expectRefused(sshDeps(ssh), 'no core: ssh backend unsupported', { ...PLACEMENT, core: null });
    await expectRefused(sshDeps(ssh), 'ssh: ticket 7 has no worktree', PLACEMENT, { ...TICKET, hostWorktreePath: '' });
    untouched(ssh);
  });

  it('checks the control dir before the first remote op, and refuses with its reason', async () => {
    const ssh = fakeSshProcess();
    const ensure = vi.fn(async () => ({ ok: false as const, reason: 'ssh: control dir /c is not private' }));
    const runner = sshRunnerFor(sshDeps(ssh, { ensureControlDir: ensure }), PLACEMENT, TICKET);
    expect(await runner.probeSandbox!()).toEqual({ state: 'unknown', reason: 'ssh: control dir /c is not private' });
    expect(await runner.sync!(REF)).toEqual({ ok: false, reason: 'ssh: control dir /c is not private' });
    expect(ensure).toHaveBeenCalledTimes(2);
    untouched(ssh);
  });

  it('every remote op checks the control dir first and refuses with its reason, with no ssh call', async () => {
    const ssh = fakeSshProcess();
    const reason = 'ssh: control dir /c is not private';
    const gate = vi.fn();
    const runner = sshRunnerFor(sshDeps(ssh, { ensureControlDir: async () => ({ ok: false as const, reason }), gateProcess: gate }), PLACEMENT, TICKET);
    const refused = { ok: false, reason };
    for (const op of [runner.sync!(REF), runner.refresh!(REF), runner.fetchClone!(REF), runner.diff!(REF), runner.shellCommand!(REF), runner.ensureWritable!(REF), runner.ensureCloneReady!('k/b')]) {
      expect(await op).toEqual(refused);
    }
    expect((await runner.dispose!(REF)).ok).toBe(false);
    expect((await runner.rebuild!(REF)).ok).toBe(false);
    expect(await runner.hasSandbox!()).toBe(true);
    expect(await runner.probeSandbox!()).toEqual({ state: 'unknown', reason });
    expect(await runner.oomReport!()).toBe(reason);
    expect(await runner.runGate!('true', [], '/wt')).toMatchObject({ kind: 'spawnFailed', message: reason });
    await expect(runner.stop!()).rejects.toThrow(reason);
    await expect(runner.prepareInteractive!({} as never)).rejects.toThrow(reason);
    expect(gate).not.toHaveBeenCalled();
    untouched(ssh);
  });

  it('a check that throws refuses with its message and is tried again on the next op', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-probe': { code: 0 } });
    const ensure = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ ok: true });
    const runner = sshRunnerFor(sshDeps(ssh, { ensureControlDir: ensure }), PLACEMENT, TICKET);
    expect(await runner.probeSandbox!()).toEqual({ state: 'unknown', reason: 'boom' });
    untouched(ssh);
    expect(await runner.probeSandbox!()).toEqual({ state: 'present' });
    expect(await runner.probeSandbox!()).toEqual({ state: 'present' });
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('checks a private control dir once', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-probe': { code: 0 } });
    const ensure = vi.fn(async () => ({ ok: true as const }));
    const runner = sshRunnerFor(sshDeps(ssh, { ensureControlDir: ensure }), PLACEMENT, TICKET);
    await runner.probeSandbox!();
    await runner.hasSandbox!();
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('uses the given gate registry: stop kills the live gates of this sandbox', async () => {
    const ssh = fakeSshProcess();
    const registry = createSshGateRegistry();
    registry.add(sshGateKey('devbox', PLACEMENT.sandboxName!.split('/')[1]!), '0123abcd');
    const runner = sshRunnerFor(sshDeps(ssh, { registry }), PLACEMENT, TICKET);
    await runner.stop!();
    expect(ssh.calls.some((c) => (c.args.at(-1) ?? '').includes('tmux kill-session'))).toBe(true);
    expect(ssh.calls.length).toBeGreaterThan(1);
    const bare = fakeSshProcess();
    await sshRunnerFor(sshDeps(bare), PLACEMENT, TICKET).stop!();
    expect(bare.calls).toHaveLength(1);
  });

  it('passes debug through to the runner', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-stop': { code: 1 } });
    const debug = vi.fn();
    await sshRunnerFor(sshDeps(ssh, { debug }), PLACEMENT, TICKET).stop!();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('[ssh devbox] stop:'));
  });

  it('a host step builds no tmux launch', () => {
    const runner = sshRunnerFor(sshDeps(fakeSshProcess()), PLACEMENT, TICKET);
    const placed = runner.placeInteractive({ ticketId: 7, hostWorktreePath: '/wt', command: 'claude', args: [], env: {} });
    expect((placed.shellArgs ?? []).join(' ')).not.toContain('tmux new-session');
  });
});
