import { describe, expect, it, vi } from 'vitest';
import { remoteTrustKey } from '../../agent/ssh/remoteTrust.js';
import { fakeSshProcess, type FakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { createSshGateRegistry, sshGateKey } from '../../agent/ssh/sshGateRegistry.js';
import type { RemoteDef } from '../../manifest/types.js';
import type { TicketPlacement } from '../../store/placement.js';
import { FAKE_REMOTE, fakeSshPlacement, fakeSshRunnerDeps, fakeTrustDir } from './fakeSshRunnerDeps.js';
import { sshRunnerFor, SSH_DEPS_MISSING, type SshRunnerDeps, type SshRunnerTicket } from './sshRunnerFor.js';

const REMOTE = FAKE_REMOTE;
const PLACEMENT = fakeSshPlacement();
const TICKET: SshRunnerTicket = { ticketId: 7, projectRoot: '/p', hostWorktreePath: '/wt' };
const REF = { hostWorktreePath: '/wt', branch: 'k/b' };
const trustDir = fakeTrustDir;
const sshDeps = fakeSshRunnerDeps;

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

  it('refuses a confirmed docker-mode remote (D822 adds it)', async () => {
    const ssh = fakeSshProcess();
    const docker: RemoteDef = { ...REMOTE, mode: 'docker' };
    await expectRefused(sshDeps(ssh, { remotes: () => ({ devbox: docker }), globalStorageDir: trustDir({ devbox: remoteTrustKey('devbox', docker) }) }), 'ssh docker mode not available yet');
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
