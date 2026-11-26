import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { fakeSbxProcess } from '../sbx/fakeSbxProcess.js';
import { fakeSshProcess } from './fakeSshProcess.js';
import { resolveSsh, type SshResolveDeps, type SshResolveInput, type SshWarnOnce } from './resolveSsh.js';
import type { SshPreflightFacts, SshPreflightResult } from './sshPreflight.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const FACTS: SshPreflightFacts = {
  os: 'Linux', uid: 1000, gid: 1000, git: '2.43', setsid: true, setsidW: true, tmux: true, node: '20.1',
  remoteDirOk: true, allowTcpForwarding: 'yes', freeMb: 20000, coreBin: '/usr/bin/claude',
};
const NO_TMUX = 'ssh devbox: tmux not found; the agent stops when the connection drops (install tmux)';

type Ssh = ReturnType<typeof fakeSshProcess>;

function input(ssh: Ssh, over: Partial<SshResolveInput> = {}, deps: Partial<SshResolveDeps> = {}): SshResolveInput {
  return {
    remoteName: 'devbox', remotes: { devbox: REMOTE }, remoteTrusted: () => true, core: 'claude',
    projectRoot: '/p', installId: 'i', ticketId: 7, worktree: { hostWorktreePath: '/wt', branch: 'feat/x' },
    deps: {
      ssh, sshBin: 'ssh', host: fakeSbxProcess(), controlDir: '/tmp/karst-ssh-0/',
      ensureControlDir: async () => ({ ok: true }),
      preflight: async () => ({ ok: true, facts: FACTS, warnings: [] }),
      clone: async () => ({ ok: true }),
      trust: async () => undefined,
      ...deps,
    },
    ...over,
  };
}

const signedIn = () => fakeSshProcess({ '# karst-ssh-login': { stdout: 'yes\n' } });

describe('resolveSsh', () => {
  it('untrusted: makes zero ssh calls', async () => {
    const ssh = fakeSshProcess();
    let preflights = 0;
    const out = await resolveSsh(input(ssh, { remoteTrusted: () => false }, { preflight: async () => { preflights += 1; return { ok: false, reason: 'x' }; } }));
    expect(out).toEqual({ ok: false, reason: "ssh: remote 'devbox' not confirmed" });
    expect(ssh.calls).toHaveLength(0);
    expect(ssh.stdinCalls).toHaveLength(0);
    expect(preflights).toBe(0);
  });

  it('an unknown remote is refused', async () => {
    expect(await resolveSsh(input(signedIn(), { remotes: {} }))).toMatchObject({ ok: false, reason: expect.stringMatching(/not in remotes/) });
  });

  it('docker mode: refused with a reason, no ssh call', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveSsh(input(ssh, { remotes: { devbox: { ...REMOTE, mode: 'docker' } } }));
    expect(out).toEqual({ ok: false, reason: 'ssh docker mode not available yet' });
    expect(ssh.calls).toHaveLength(0);
  });

  it('preflight failure: returns its reason', async () => {
    const out = await resolveSsh(input(signedIn(), {}, { preflight: async (): Promise<SshPreflightResult> => ({ ok: false, reason: 'ssh devbox: git not found' }) }));
    expect(out).toEqual({ ok: false, reason: 'ssh devbox: git not found' });
  });

  it('a core not signed in on the remote names the remote command to run', async () => {
    const out = await resolveSsh(input(fakeSshProcess({ '# karst-ssh-login': { stdout: 'no\n' } })));
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('run `claude (then /login)` on karst@vm.example.com') });
  });

  it('opencode2 uses auth list, never auth export', async () => {
    const ssh = fakeSshProcess({ '# karst-ssh-login': { stdout: 'No authenticated integrations\n' } });
    const out = await resolveSsh(input(ssh, { core: 'opencode2' }, { preflight: async () => ({ ok: true, facts: { ...FACTS, coreBin: '/usr/bin/opencode2' }, warnings: [] }) }));
    expect(out.ok).toBe(false);
    const script = ssh.calls[0]!.args.at(-1)!;
    expect(script).toContain('auth');
    expect(script).toContain('list');
    expect(script).not.toContain('export');
  });

  it('a clone failure returns its reason', async () => {
    const out = await resolveSsh(input(signedIn(), {}, { clone: async () => ({ ok: false, reason: 'bundle failed' }) }));
    expect(out).toEqual({ ok: false, reason: 'bundle failed' });
  });

  it('success: a runner, the names and no warning with tmux', async () => {
    const out = await resolveSsh(input(signedIn()));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runner.kind).toBe('ssh');
    expect(out.names.remote).toBe('devbox');
    expect(out.names.name).toMatch(/^karst-[0-9a-f]{8}-7-claude$/);
    expect(out.warnings).toEqual([]);
  });

  it('no tmux (b): WARN once across two launches, and the warning is returned each time', async () => {
    const warnOnce: SshWarnOnce = { warned: new Set() };
    const warns: string[] = [];
    const deps: Partial<SshResolveDeps> = {
      warnOnce, warn: (m) => warns.push(m),
      preflight: async () => ({ ok: true, facts: { ...FACTS, tmux: false }, warnings: [NO_TMUX] }),
    };
    const first = await resolveSsh(input(signedIn(), {}, deps));
    const second = await resolveSsh(input(signedIn(), {}, deps));
    expect(warns).toEqual([NO_TMUX]);
    expect(first.ok && first.warnings).toEqual([NO_TMUX]);
    expect(second.ok && second.warnings).toEqual([NO_TMUX]);
  });

  it('bounds the whole step', async () => {
    const out = await resolveSsh(input(signedIn(), {}, { timeoutMs: 5, preflight: () => new Promise(() => undefined) }));
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/did not finish/) });
  });

  it('never throws', async () => {
    const out = await resolveSsh(input(signedIn(), {}, { preflight: async () => { throw new Error('boom'); } }));
    expect(out).toEqual({ ok: false, reason: 'boom' });
  });
});
