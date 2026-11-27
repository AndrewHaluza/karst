import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import type { PrepareInput } from '../docker/dockerRunner.js';
import { dockerNames } from '../docker/dockerNames.js';
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

// `mode: docker` (D822): the remote daemon facts come from `sshPreflight`; the
// container runs as the REMOTE uid/gid (1000/1001 here, never the host's).
const DOCKER_REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'docker', remoteDir: '/srv/karst' };
const DOCKER_FACTS: SshPreflightFacts = { ...FACTS, uid: 1000, gid: 1001, docker: '27.0.3', coreBin: undefined };

function dockerDeps(ssh: Ssh, over: Partial<SshResolveDeps> = {}): SshResolveDeps {
  return {
    ssh, sshBin: 'ssh', host: fakeSbxProcess(), controlDir: '/tmp/karst-ssh-0/',
    ensureControlDir: async () => ({ ok: true }),
    preflight: async () => ({ ok: true, facts: DOCKER_FACTS, warnings: [] }),
    ensureAssets: async () => ({ ok: true }),
    dockerPreflight: async () => ({ ok: true }),
    prepareDocker: async () => ({ ok: true }),
    egressProbe: async () => ({ ok: true }),
    hostAuthFile: async () => undefined,
    opencode2Host: () => ({ command: 'opencode2', env: {} }),
    ...over,
  };
}

function dockerInput(ssh: Ssh, over: Partial<SshResolveInput> = {}, deps: Partial<SshResolveDeps> = {}): SshResolveInput {
  return {
    remoteName: 'devbox', remotes: { devbox: DOCKER_REMOTE }, remoteTrusted: () => true, core: 'opencode',
    projectRoot: '/p', installId: 'i', ticketId: 7, worktree: { hostWorktreePath: '/wt', branch: 'feat/x' },
    deps: dockerDeps(ssh, deps),
    ...over,
  };
}

/** Decode the ONE quoting layer of `sshArgv` (`sh -c '<script>'`). */
function sshScriptOf(args: readonly string[]): string {
  return (args.at(-1) ?? '').replace(/^sh -c '/s, '').replace(/'$/s, '').split(`'\\''`).join("'");
}

describe('resolveSsh docker mode (D822)', () => {
  it('success: a sandbox-enforcing ssh runner, autonomous, with the remote uid/gid and no host ports', async () => {
    const ssh = fakeSshProcess();
    const prepared: PrepareInput[] = [];
    const out = await resolveSsh(dockerInput(ssh, {}, {
      prepareDocker: async (input) => { prepared.push(input); return { ok: true }; },
    }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runner.kind).toBe('ssh');
    expect(out.runner.enforcesSandbox).toBe(true);
    expect(out.runner.autonomous).toBe(true);
    expect(out.names).toEqual({ remote: 'devbox', name: expect.stringMatching(/^karst-[0-9a-f]{8}-7-opencode$/) });
    expect(prepared).toHaveLength(1);
    const input = prepared[0]!;
    expect(input.user).toEqual({ uid: 1000, gid: 1001 });
    expect(input.core).toBe('opencode');
    expect(input.hostPorts).toBeUndefined();
    expect(input.mountRoot?.assetsDir).toBe('/srv/karst/.karst-assets/r4');
    expect(input.mountRoot?.bridgeDir).toBe(`/srv/karst/${out.names.name}/bridge/7`);
    expect(input.proxyScript).toBe('/srv/karst/.karst-assets/r4/allowlist-proxy.mjs');
    // The clone seed is the D554 bundle step, not a host temp-dir bind mount.
    expect(input.seedClone).toBeTypeOf('function');
  });

  it('opencode gets the v1 host auth file; opencode2 gets the host export command', async () => {
    const prepared: PrepareInput[] = [];
    const prepare = async (i: PrepareInput) => { prepared.push(i); return { ok: true as const }; };
    await resolveSsh(dockerInput(fakeSshProcess(), {}, {
      prepareDocker: prepare, hostAuthFile: async (account) => `/host/${account ?? 'default'}/auth.json`,
    }));
    expect(prepared[0]!.opencode1HostAuthFile).toBe('/host/default/auth.json');
    expect(prepared[0]!.opencode2Host).toBeUndefined();
    prepared.length = 0;
    await resolveSsh(dockerInput(fakeSshProcess(), { core: 'opencode2' }, {
      prepareDocker: prepare, opencode2Host: () => ({ command: '/host/opencode2', env: { XDG_DATA_HOME: '/host/xdg' } }),
    }));
    expect(prepared[0]!.opencode2Host).toEqual({ command: '/host/opencode2', env: { XDG_DATA_HOME: '/host/xdg' } });
    expect(prepared[0]!.opencode1HostAuthFile).toBeUndefined();
  });

  it('an egress failure falls back with the reason AND stops the proxy sidecar', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveSsh(dockerInput(ssh, {}, {
      egressProbe: async () => ({ ok: false, reason: 'direct IPv4 egress succeeded' }),
    }));
    expect(out).toEqual({ ok: false, reason: 'ssh docker egress not enforced: direct IPv4 egress succeeded' });
    const { container } = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode', installId: 'i' });
    expect(ssh.calls.some((call) => sshScriptOf(call.args) === `docker 'rm' '--force' '${container}-proxy'`)).toBe(true);
  });

  it('refuses declared baseline host ports before any ssh call (host-gateway is the VM)', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveSsh(dockerInput(ssh, { hostPorts: [5432] }));
    expect(out).toEqual({ ok: false, reason: 'ssh docker mode: host services are not supported' });
    expect(ssh.calls).toHaveLength(0);
    expect(ssh.stdinCalls).toHaveLength(0);
  });

  it('fails closed on a tampered asset upload (a wrong proxy bundle would disable the allowlist)', async () => {
    const ssh = fakeSshProcess();
    const prepared: PrepareInput[] = [];
    const out = await resolveSsh(dockerInput(ssh, {}, {
      ensureAssets: async () => ({ ok: false, reason: 'ssh devbox: remote asset checksum mismatch for allowlist-proxy.mjs' }),
      prepareDocker: async (i) => { prepared.push(i); return { ok: true }; },
    }));
    expect(out).toEqual({ ok: false, reason: 'ssh devbox: remote asset checksum mismatch for allowlist-proxy.mjs' });
    expect(prepared).toHaveLength(0);
    expect(ssh.calls).toHaveLength(0);
  });

  it('a remote docker preflight failure is the reason, and nothing is prepared', async () => {
    const prepared: PrepareInput[] = [];
    const out = await resolveSsh(dockerInput(fakeSshProcess(), {}, {
      dockerPreflight: async () => ({ ok: false, reason: 'docker daemon not reachable over the remote transport: down' }),
      prepareDocker: async (i) => { prepared.push(i); return { ok: true }; },
    }));
    expect(out).toEqual({ ok: false, reason: 'docker daemon not reachable over the remote transport: down' });
    expect(prepared).toHaveLength(0);
  });

  it('a remote preflight failure is the reason', async () => {
    const out = await resolveSsh(dockerInput(fakeSshProcess(), {}, {
      preflight: async () => ({ ok: false, reason: 'ssh devbox: docker daemon not reachable' }),
    }));
    expect(out).toEqual({ ok: false, reason: 'ssh devbox: docker daemon not reachable' });
  });

  it('a missing worktree branch is the reason, before any ssh call', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveSsh(dockerInput(ssh, { worktree: undefined }));
    expect(out).toEqual({ ok: false, reason: 'ssh: ticket has no worktree branch to clone' });
    expect(ssh.calls).toHaveLength(0);
  });

  it('an untrusted remote makes zero ssh calls in docker mode too', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveSsh(dockerInput(ssh, { remoteTrusted: () => false }));
    expect(out).toEqual({ ok: false, reason: "ssh: remote 'devbox' not confirmed" });
    expect(ssh.calls).toHaveLength(0);
  });
});

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

  it('docker mode: unsupported core is refused with zero ssh calls', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveSsh(dockerInput(ssh, { core: 'claude' }));
    expect(out).toEqual({ ok: false, reason: 'claude: ssh docker mode supports only opencode, opencode2' });
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
