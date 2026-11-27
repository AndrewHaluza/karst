import { describe, expect, it, vi } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { remoteTrustKey } from '../../agent/ssh/remoteTrust.js';
import { fakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { blockedSshRunner, liveRemoteSession, sshPlacementTarget } from './sshPlacementOps.js';
import type { TicketPlacement } from '../../store/placement.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const NAME = 'karst-abcd1234-7-claude';
const placement = (over: Partial<TicketPlacement> = {}): TicketPlacement => ({ backend: 'ssh', core: 'claude', sandboxName: `devbox/${NAME}`, reason: null, ...over });
const trusted = { devbox: remoteTrustKey('devbox', REMOTE) };
const deps = (ssh: ReturnType<typeof fakeSshProcess>) => ({ ssh, controlDir: '/tmp/karst-ssh-0/', ensureControlDir: async () => ({ ok: true as const }) });

describe('sshPlacementTarget', () => {
  it('splits <remote>/<name>, and is empty for every other placement', () => {
    expect(sshPlacementTarget(placement())).toEqual({ remote: 'devbox', sandboxName: NAME });
    expect(sshPlacementTarget(placement({ backend: 'host', sandboxName: null }))).toBeUndefined();
    expect(sshPlacementTarget(placement({ backend: 'sbx' }))).toBeUndefined();
    expect(sshPlacementTarget(null)).toBeUndefined();
    expect(sshPlacementTarget(placement({ sandboxName: 'devbox' }))).toBeUndefined();
    expect(sshPlacementTarget(placement({ sandboxName: '/name' }))).toBeUndefined();
    expect(sshPlacementTarget(placement({ sandboxName: 'devbox/' }))).toBeUndefined();
    expect(sshPlacementTarget(placement({ sandboxName: null }))).toBeUndefined();
    expect(sshPlacementTarget(placement({ sandboxName: 'a/b' }))).toEqual({ remote: 'a', sandboxName: 'b' });
  });
});

describe('blockedSshRunner (D826)', () => {
  const REASON = 'ssh remote devbox not confirmed';
  const ref = { hostWorktreePath: '/wt', branch: 'k/b' };

  it('refuses every sandbox action with the given reason', async () => {
    const runner = blockedSshRunner(REASON);
    expect(runner.kind).toBe('ssh');
    expect(runner.enforcesSandbox).toBe(false);
    expect(runner.autonomous).toBe(false);
    for (const step of [runner.sync!(ref), runner.refresh!(ref), runner.fetchClone!(ref), runner.diff!(ref), runner.shellCommand!(ref), runner.ensureWritable!(ref), runner.ensureCloneReady!('k/b'), runner.prepareLaunch!()]) {
      expect(await step).toEqual({ ok: false, reason: REASON });
    }
    expect(await runner.runGate!('true', [], '/wt')).toMatchObject({ kind: 'spawnFailed', message: REASON, output: REASON });
    expect(await runner.dispose!(ref)).toEqual({ ok: false, steps: [{ step: 'ssh', status: 'failed', stderr: REASON }] });
    expect(await runner.rebuild!(ref)).toEqual({ ok: false, steps: [{ step: 'ssh', status: 'failed', stderr: REASON }] });
    await expect(runner.stop!()).rejects.toThrow(REASON);
    await expect(runner.prepareInteractive!({} as never)).rejects.toThrow(REASON);
    expect(() => runner.placeInteractive({} as never)).toThrow(REASON);
    expect(await runner.oomReport!()).toBe(REASON);
  });

  it('never proves the sandbox absent: hasSandbox is true, the probe is unknown', async () => {
    const runner = blockedSshRunner(REASON);
    expect(await runner.hasSandbox!()).toBe(true);
    expect(await runner.probeSandbox!()).toEqual({ state: 'unknown', reason: REASON });
  });
});

describe('liveRemoteSession (D555 recovery)', () => {
  it('is false for a non-ssh placement without an ssh call', async () => {
    const ssh = fakeSshProcess();
    expect(await liveRemoteSession({ placement: placement({ backend: 'sbx' }), remotes: { devbox: REMOTE }, trust: trusted, deps: deps(ssh) })).toBe(false);
    expect(ssh.calls).toHaveLength(0);
  });

  it('an untrusted remote makes zero ssh calls', async () => {
    const ssh = fakeSshProcess();
    expect(await liveRemoteSession({ placement: placement(), remotes: { devbox: REMOTE }, trust: {}, deps: deps(ssh) })).toBe(false);
    expect(ssh.calls).toHaveLength(0);
  });

  it('docker mode is never counted as live', async () => {
    const ssh = fakeSshProcess();
    const docker = { ...REMOTE, mode: 'docker' as const };
    expect(await liveRemoteSession({ placement: placement(), remotes: { devbox: docker }, trust: { devbox: remoteTrustKey('devbox', docker) }, deps: deps(ssh) })).toBe(false);
    expect(ssh.calls).toHaveLength(0);
  });

  it('a live tmux session is true, over one hardened ssh call with an exact-match target', async () => {
    const ssh = fakeSshProcess({ 'tmux has-session': { code: 0 } });
    expect(await liveRemoteSession({ placement: placement(), remotes: { devbox: REMOTE }, trust: trusted, deps: deps(ssh) })).toBe(true);
    expect(ssh.calls).toHaveLength(1);
    const args = ssh.calls[0]!.args;
    expect(args).toContain('--');
    expect(args.at(-1)).toContain('tmux has-session -t');
    expect(args.at(-1)).toContain(`=${NAME}`);
    expect(args.at(-1)!.startsWith('sh -c ')).toBe(true);
    expect(args.join(' ')).toContain('ControlPath=/tmp/karst-ssh-0/');
    expect(ssh.calls[0]!.opts).toEqual({ maxStdoutBytes: 4096 });
  });

  it('uses the injected control dir step, and a failed step is false without an ssh call', async () => {
    const ssh = fakeSshProcess({ 'tmux has-session': { code: 0 } });
    const ensureControlDir = vi.fn(async () => ({ ok: false as const, reason: 'no dir' }));
    const out = await liveRemoteSession({ placement: placement(), remotes: { devbox: REMOTE }, trust: trusted, deps: { ...deps(ssh), ensureControlDir } });
    expect(out).toBe(false);
    expect(ensureControlDir).toHaveBeenCalledWith('/tmp/karst-ssh-0/');
    expect(ssh.calls).toHaveLength(0);
  });

  it('exit 0 with a transport failure is not live', async () => {
    const ssh = fakeSshProcess({ 'tmux has-session': { code: 0, transport: true } });
    expect(await liveRemoteSession({ placement: placement(), remotes: { devbox: REMOTE }, trust: trusted, deps: deps(ssh) })).toBe(false);
  });

  it('no remotes table is false without an ssh call', async () => {
    const ssh = fakeSshProcess();
    expect(await liveRemoteSession({ placement: placement(), remotes: undefined, trust: trusted, deps: deps(ssh) })).toBe(false);
    expect(ssh.calls).toHaveLength(0);
  });

  it('a dead session, a transport failure or a missing remote is false', async () => {
    const dead = fakeSshProcess({ 'tmux has-session': { code: 1 } });
    expect(await liveRemoteSession({ placement: placement(), remotes: { devbox: REMOTE }, trust: trusted, deps: deps(dead) })).toBe(false);
    const down = fakeSshProcess({ 'tmux has-session': { code: 255, transport: true } });
    expect(await liveRemoteSession({ placement: placement(), remotes: { devbox: REMOTE }, trust: trusted, deps: deps(down) })).toBe(false);
    const ssh = fakeSshProcess();
    expect(await liveRemoteSession({ placement: placement(), remotes: {}, trust: trusted, deps: deps(ssh) })).toBe(false);
    expect(ssh.calls).toHaveLength(0);
  });

  it('refuses a malformed remote sandbox name without an ssh call', async () => {
    const ssh = fakeSshProcess();
    expect(await liveRemoteSession({ placement: placement({ sandboxName: 'devbox/not-a-karst-name' }), remotes: { devbox: REMOTE }, trust: trusted, deps: deps(ssh) })).toBe(false);
    expect(ssh.calls).toHaveLength(0);
  });
});
