import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureAccounts, resetAccounts } from './accounts/registry.js';
import { resolveBackend } from './backendResolver.js';
import { fakeSbxProcess } from './sbx/fakeSbxProcess.js';
import { fakeSshProcess } from './ssh/fakeSshProcess.js';
import { HOST_SESSION_RUNNER } from './sessionRunner.js';
import type { RemoteDef } from '../manifest/types.js';
import type { SshPreflightFacts, SshPreflightResult } from './ssh/sshPreflight.js';
import type { SshResolveDeps } from './ssh/resolveSsh.js';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = mkdtempSync(join(tmpdir(), 'karst-resolve-'));
const worktree = { hostWorktreePath: join(projectRoot, '.karst', 'worktrees', 't7'), branch: 'karst/t7' };
const base = { core: 'claude', projectRoot: '/p', ticketId: 7, proc: fakeSbxProcess(), remoteTrusted: () => false };
const ok = vi.fn().mockResolvedValue({ ok: true, existing: [] });

describe('resolveBackend account', () => {
  afterEach(() => resetAccounts());
  it('uses the host for a stored account under sbx, and sbx for the default account', async () => {
    configureAccounts({ claude: { active: 'work', list: { work: { kind: 'subscription', source: 'folder', dir: '/h/work' } } } });
    const blocked = await resolveBackend({ ...base, backends: { claude: 'sbx' }, preflight: ok, worktree });
    expect(blocked.runner).toBe(HOST_SESSION_RUNNER);
    expect(blocked.line).toMatch(/^host \(claude account 'work'.*no sbx token.*\)$/);
    const def = await resolveBackend({ ...base, projectRoot, backends: { claude: 'sbx' }, preflight: ok, worktree, account: 'default' });
    expect(def.runner.kind).toBe('sbx');
  });
  it('types the account block, so callers never parse the line', async () => {
    configureAccounts({ claude: { active: 'work', list: { work: { kind: 'subscription', source: 'folder', dir: '/h/work' } } } });
    const blocked = await resolveBackend({ ...base, backends: { claude: 'sbx' }, preflight: ok, worktree });
    expect(blocked.blocked).toEqual({ kind: 'account', reason: expect.stringMatching(/claude account 'work'.*no sbx token/)});
    const def = await resolveBackend({ ...base, projectRoot, backends: { claude: 'sbx' }, preflight: ok, worktree, account: 'default' });
    expect(def.blocked).toBeUndefined();
    const other = await resolveBackend({ ...base, core: 'opencode', backends: { opencode: 'sbx' }, preflight: ok });
    expect(other.blocked).toBeUndefined();
  });
});

describe('resolveBackend', () => {
  it('defaults to host without running preflight', async () => {
    const preflight = vi.fn();
    const out = await resolveBackend({ ...base, backends: undefined, preflight });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (agentBackends.claude: host)' });
    expect(preflight).not.toHaveBeenCalled();
    expect((await resolveBackend({ ...base, backends: { claude: 'host' }, preflight })).runner).toBe(HOST_SESSION_RUNNER);
  });

  it.each(['claude', 'codex'])('picks sbx for %s when preflight passes', async (core) => {
    const out = await resolveBackend({ ...base, projectRoot, core, backends: { [core]: 'sbx' }, preflight: ok, worktree });
    expect(out.runner.kind).toBe('sbx');
    expect(out.runner.enforcesSandbox).toBe(true);
    expect(out.line).toMatch(new RegExp(`^sbx \\(karst-[0-9a-f]{8}-7-${core}\\)$`));
    const args = out.runner.placeInteractive({ ticketId: 7, hostWorktreePath: worktree.hostWorktreePath, command: core, args: [], env: {} }).shellArgs;
    expect(args).not.toContain(worktree.hostWorktreePath);
    expect(args[args.indexOf(core) + 1]).toContain(join(projectRoot, '.karst', 'sbx-clones'));
  });

  it('fails closed to host when there is no worktree branch to clone', async () => {
    const out = await resolveBackend({ ...base, backends: { claude: 'sbx' }, preflight: ok });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (sbx: no ticket worktree branch to clone)' });
  });

  it('fails closed to host when origin cannot be dropped', async () => {
    const proc = fakeSbxProcess({ 'git -C': { code: 1, stderr: 'locked' } });
    const out = await resolveBackend({ ...base, projectRoot, proc, backends: { claude: 'sbx' }, preflight: ok, worktree });
    expect(out.line).toBe('host (sandbox clone could not drop origin: locked)');
  });

  it('fails closed to host when the clone fails', async () => {
    const proc = fakeSbxProcess({ 'git clone': { code: 128, stderr: 'boom' } });
    const out = await resolveBackend({ ...base, projectRoot, proc, backends: { claude: 'sbx' }, preflight: ok, worktree });
    expect(out.line).toBe('host (sandbox clone failed: boom)');
  });

  it('keeps an unsupported core on host with a reason', async () => {
    const preflight = vi.fn();
    const out = await resolveBackend({ ...base, core: 'opencode', backends: { opencode: 'sbx' }, preflight });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (opencode: sbx backend unsupported)' });
    expect(preflight).not.toHaveBeenCalled();
  });

  it('falls back to host with the preflight reason', async () => {
    const preflight = vi.fn().mockResolvedValue({ ok: false, reason: 'sbx not signed in (run `sbx login`)' });
    const out = await resolveBackend({ ...base, backends: { claude: 'sbx' }, preflight });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (sbx not signed in (run `sbx login`))' });
  });

  const dockerDeps = { preflight: vi.fn().mockResolvedValue({ ok: true }), prepare: vi.fn().mockResolvedValue({ ok: true }), hostAuthFile: () => Promise.resolve(undefined) };
  const worktree = { hostWorktreePath: '/w/t7', branch: 'feat/x' };

  it.each(['opencode', 'opencode2', 'antigravity', 'agy'])('picks docker for %s when preflight and prepare pass', async (core) => {
    const out = await resolveBackend({ ...base, core, backends: { [core]: 'docker' } as any, worktree, docker: dockerDeps });
    expect(out.runner.kind).toBe('docker');
    expect(out.runner.enforcesSandbox).toBe(true);
    const expectedName = core === 'agy' ? 'antigravity' : core;
    expect(out.line).toMatch(new RegExp(`^docker \\(karst-[0-9a-f]{8}-7-${expectedName}\\)$`));
  });

  it.each(['claude', 'codex'])('keeps %s on host under docker with a reason', async (core) => {
    const out = await resolveBackend({ ...base, core, backends: { [core]: 'docker' }, worktree, docker: dockerDeps });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: `host (${core}: docker backend unsupported)` });
  });

  it('forwards bridgeDir to resolveDocker when backend is docker', async () => {
    const prepare = vi.fn().mockResolvedValue({ ok: true });
    await resolveBackend({
      ...base,
      core: 'agy',
      backends: { agy: 'docker' },
      worktree,
      bridgeDir: '/bridge/events/7',
      docker: { ...dockerDeps, prepare },
    });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ bridgeDir: '/bridge/events/7' }));
  });

  it('falls back to host with the docker reason', async () => {
    const docker = { ...dockerDeps, preflight: vi.fn().mockResolvedValue({ ok: false, reason: 'docker not installed (not on PATH)' }) };
    const out = await resolveBackend({ ...base, core: 'opencode', backends: { opencode: 'docker' }, worktree, docker });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (docker not installed (not on PATH))' });
  });

  it('keeps docker on host without a worktree branch', async () => {
    const out = await resolveBackend({ ...base, core: 'opencode', backends: { opencode: 'docker' }, docker: dockerDeps });
    expect(out.line).toBe('host (docker: ticket has no worktree branch to clone)');
  });

  it('falls back to host when no valid name can be built', async () => {
    const out = await resolveBackend({ ...base, ticketId: 0, backends: { claude: 'sbx' }, preflight: ok });
    expect(out.runner).toBe(HOST_SESSION_RUNNER);
    expect(out.line).toMatch(/^host \(sbx name: invalid ticket id 0\)$/);
  });

  it('only the session cores entry counts', async () => {
    const preflight = vi.fn();
    const out = await resolveBackend({ ...base, core: 'claude', backends: { opencode: 'docker' }, preflight });
    expect(out.line).toBe('host (agentBackends.claude: host)');
    expect(preflight).not.toHaveBeenCalled();
  });

  it('uses an injected host runner', async () => {
    const host = { ...HOST_SESSION_RUNNER };
    expect((await resolveBackend({ ...base, backends: undefined, host })).runner).toBe(host);
  });
});

const SSH_REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const SSH_FACTS: SshPreflightFacts = {
  os: 'Linux', uid: 1000, gid: 1000, git: '2.43', setsid: true, setsidW: true, tmux: true, node: '20.1',
  remoteDirOk: true, allowTcpForwarding: 'yes', freeMb: 20000, coreBin: '/usr/bin/claude',
};

function sshDeps(ssh: ReturnType<typeof fakeSshProcess>, over: { readonly preflight?: () => Promise<SshPreflightResult> } = {}) {
  return {
    ssh, sshBin: 'ssh', host: fakeSbxProcess(), controlDir: '/tmp/karst-ssh-0/',
    ensureControlDir: async () => ({ ok: true as const }),
    preflight: over.preflight ?? (async () => ({ ok: true as const, facts: SSH_FACTS, warnings: [] })),
    clone: async () => ({ ok: true as const }),
    trust: async () => undefined,
  };
}

/** The `mode: docker` seams (D822): every remote step is faked; nothing here touches a daemon. */
function dockerSshDeps(ssh: ReturnType<typeof fakeSshProcess>, over: Partial<SshResolveDeps> = {}): SshResolveDeps {
  return {
    ...sshDeps(ssh),
    preflight: async () => ({ ok: true as const, facts: { ...SSH_FACTS, docker: '27.0.3' }, warnings: [] }),
    ensureAssets: async () => ({ ok: true as const }),
    dockerPreflight: async () => ({ ok: true as const }),
    prepareDocker: async () => ({ ok: true as const }),
    egressProbe: async () => ({ ok: true as const }),
    hostAuthFile: async () => undefined,
    opencode2Host: () => ({ command: 'opencode2', env: {} }),
    ...over,
  };
}

const DOCKER_BASE = { ...base, core: 'opencode', backends: { opencode: 'ssh:devbox' as const }, remotes: { devbox: { ...SSH_REMOTE, mode: 'docker' as const } }, installId: 'install1', remoteTrusted: () => true, worktree };

describe('resolveBackend ssh backend (D555)', () => {
  afterEach(() => resetAccounts());
  const sshBase = { ...base, core: 'claude', backends: { claude: 'ssh:devbox' as const }, remotes: { devbox: SSH_REMOTE }, installId: 'install1', remoteTrusted: () => true, worktree };

  it('a trusted direct remote resolves to the ssh runner, prompted', async () => {
    const ssh = fakeSshProcess({ '# karst-ssh-login': { stdout: 'yes\n' } });
    const out = await resolveBackend({ ...sshBase, ssh: sshDeps(ssh) });
    expect(out.runner.kind).toBe('ssh');
    expect(out.runner.enforcesSandbox).toBe(false);
    expect(out.line).toMatch(/^ssh \(devbox\/karst-[0-9a-f]{8}-7-claude\)$/);
    expect(out.blocked).toBeUndefined();
  });

  it('a preflight failure falls back to the host with its reason', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveBackend({ ...sshBase, ssh: sshDeps(ssh, { preflight: async () => ({ ok: false, reason: 'ssh devbox: git not found' }) }) });
    expect(out.runner).toBe(HOST_SESSION_RUNNER);
    expect(out.line).toBe('host (ssh devbox: git not found)');
  });

  it('docker mode: an egress failure falls back to the host with the reason', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveBackend({
      ...DOCKER_BASE,
      ssh: dockerSshDeps(ssh, { egressProbe: async () => ({ ok: false, reason: 'direct IPv6 egress succeeded' }) }),
    });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (ssh docker egress not enforced: direct IPv6 egress succeeded)' });
  });

  it('docker mode: a verified remote daemon resolves to an ssh runner that enforces the sandbox', async () => {
    const out = await resolveBackend({ ...DOCKER_BASE, ssh: dockerSshDeps(fakeSshProcess()) });
    expect(out.runner.kind).toBe('ssh');
    expect(out.runner.enforcesSandbox).toBe(true);
    expect(out.runner.autonomous).toBe(true);
    expect(out.line).toMatch(/^ssh \(devbox\/karst-[0-9a-f]{8}-7-opencode\)$/);
    expect(out.blocked).toBeUndefined();
  });

  it('docker mode: a folder account is allowed (its credentials go into the container), not the ssh rule', async () => {
    configureAccounts({ opencode: { active: 'work', list: { work: { kind: 'subscription', source: 'folder', dir: '/h/work' } } } });
    const out = await resolveBackend({ ...DOCKER_BASE, ssh: dockerSshDeps(fakeSshProcess()) });
    expect(out.blocked).toBeUndefined();
    expect(out.runner.kind).toBe('ssh');
  });

  it('docker mode: a declared baseline host port is refused before any ssh call (D823)', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveBackend({ ...DOCKER_BASE, docker: { hostPorts: [5432] }, ssh: dockerSshDeps(ssh) });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (ssh docker mode: host services are not supported)' });
    expect(ssh.calls).toHaveLength(0);
    expect(ssh.stdinCalls).toHaveLength(0);
  });

  it('an unconfirmed remote makes zero ssh calls', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveBackend({ ...sshBase, remoteTrusted: () => false, ssh: sshDeps(ssh) });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: "host (ssh: remote 'devbox' not confirmed)" });
    expect(ssh.calls).toHaveLength(0);
    expect(ssh.stdinCalls).toHaveLength(0);
  });

  it('a missing install id fails closed without an ssh call', async () => {
    const ssh = fakeSshProcess();
    const out = await resolveBackend({ ...sshBase, installId: undefined, ssh: sshDeps(ssh) });
    expect(out.runner).toBe(HOST_SESSION_RUNNER);
    expect(out.line).toMatch(/^host \(ssh: the karst install id/);
    expect(ssh.calls).toHaveLength(0);
  });

  it('an account block uses the ssh rule, before any ssh call', async () => {
    configureAccounts({ claude: { active: 'work', list: { work: { kind: 'subscription', source: 'folder', dir: '/h/work' } } } });
    const ssh = fakeSshProcess();
    const out = await resolveBackend({ ...sshBase, ssh: sshDeps(ssh) });
    expect(out.runner).toBe(HOST_SESSION_RUNNER);
    expect(out.blocked?.reason).toContain('ssh remote cannot use it');
    expect(ssh.calls).toHaveLength(0);
  });
});

describe('resolveBackend sbx token account', () => {
  afterEach(() => resetAccounts());
  const grants = { issue: vi.fn(), release: vi.fn() };
  const work = { claude: { active: 'work', list: { work: { kind: 'subscription', source: 'folder', dir: '/h/work' } } } } as const;
  it('runs a token account in sbx and hands the runner the account', async () => {
    configureAccounts(work as never);
    const out = await resolveBackend({ ...base, projectRoot, backends: { claude: 'sbx' }, preflight: ok, worktree, oauth: { grants, tokenAccounts: new Set(['work']) } });
    expect(out.blocked).toBeUndefined();
    expect(out.runner.kind).toBe('sbx');
    expect(out.runner.prepareLaunch).toBeTypeOf('function');
  });
  it('lets the default account release a stale grant', async () => {
    configureAccounts(work as never);
    const out = await resolveBackend({ ...base, projectRoot, backends: { claude: 'sbx' }, preflight: ok, worktree, account: 'default', oauth: { grants, tokenAccounts: new Set(['work']) } });
    expect(out.runner.prepareLaunch).toBeTypeOf('function');
  });
  it('gives no prepare step to codex', async () => {
    const out = await resolveBackend({ ...base, projectRoot, core: 'codex', backends: { codex: 'sbx' }, preflight: ok, worktree, oauth: { grants, tokenAccounts: new Set() } });
    expect(out.runner.prepareLaunch).toBeUndefined();
  });
});
