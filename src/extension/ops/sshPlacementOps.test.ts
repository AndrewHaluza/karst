import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { remoteTrustKey } from '../../agent/ssh/remoteTrust.js';
import { fakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { blockedSshRunner, liveRemoteSession, sshPlacementTarget, SSH_RUNNER_NOT_WIRED } from './sshPlacementOps.js';
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
  });
});

describe('blockedSshRunner (D555 → D826)', () => {
  it('fails closed for every gate and sync action', async () => {
    const runner = blockedSshRunner();
    expect(runner.kind).toBe('ssh');
    expect(runner.enforcesSandbox).toBe(false);
    expect(await runner.sync!({ hostWorktreePath: '/wt', branch: 'k/b' })).toEqual({ ok: false, reason: SSH_RUNNER_NOT_WIRED });
    expect(await runner.refresh!({ hostWorktreePath: '/wt', branch: 'k/b' })).toEqual({ ok: false, reason: SSH_RUNNER_NOT_WIRED });
    expect(await runner.runGate!('true', [], '/wt')).toMatchObject({ kind: 'spawnFailed', message: SSH_RUNNER_NOT_WIRED });
    expect(await runner.hasSandbox!()).toBe(true);
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
