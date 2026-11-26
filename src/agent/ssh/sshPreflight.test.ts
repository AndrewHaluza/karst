import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import type { SshProcess } from './sshProcess.js';
import { fakeSshProcess, type FakeSshAnswer } from './fakeSshProcess.js';
import {
  MIN_REMOTE_FREE_MB,
  MIN_REMOTE_NODE,
  WARN_REMOTE_FREE_MB,
  sshPreflight,
  type SshPreflightOptions,
} from './sshPreflight.js';

const NAME = 'devbox';
const CONTROL_DIR = '/tmp/karst-ssh-501/';

const DIRECT: RemoteDef = {
  host: 'devbox.example.com',
  user: 'karst',
  port: 2222,
  keyPath: '~/.ssh/id_ed25519',
  mode: 'direct',
  remoteDir: '/srv/karst',
};

const DOCKER: RemoteDef = { ...DIRECT, mode: 'docker' };

const OPTS: SshPreflightOptions = { controlDir: CONTROL_DIR, core: 'claude' };

/** The remote script echoes these; `undefined` drops the line (a fact the remote did not report). */
function facts(overrides: Record<string, string | undefined> = {}): string {
  const values: Record<string, string | undefined> = {
    os: 'Linux',
    uid: '1000',
    gid: '1000',
    git: 'git version 2.47.3',
    setsid: 'yes',
    setsidW: 'yes',
    tmux: 'yes',
    node: 'v22.11.0',
    remoteDirStat: '1000 700',
    allowTcpForwarding: 'yes',
    freeKb: '52428800',
    ...overrides,
  };
  const lines = Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return `${lines.join('\n')}\n`;
}

const DIRECT_FACTS = { coreBin: '/usr/local/bin/claude', coreVersion: '2.0.1' };
const DOCKER_FACTS = { docker: '29.1.3', dockerExit: '0' };

async function runPreflight(
  stdout: string,
  opts: SshPreflightOptions = OPTS,
  remote: RemoteDef = DIRECT,
  answer: FakeSshAnswer = {},
) {
  const proc = fakeSshProcess({ 'karst-ssh-preflight': { stdout, ...answer } });
  const result = await sshPreflight(NAME, remote, proc, opts);
  return { proc, result };
}

describe('sshPreflight · the direct mode happy path', () => {
  it('reports every fact and no warnings', async () => {
    const { result } = await runPreflight(facts(DIRECT_FACTS));
    expect(result).toEqual({
      ok: true,
      facts: {
        os: 'Linux',
        uid: 1000,
        gid: 1000,
        git: '2.47.3',
        setsid: true,
        setsidW: true,
        tmux: true,
        node: '22.11.0',
        remoteDirOk: true,
        allowTcpForwarding: 'yes',
        freeMb: 51200,
        coreBin: '/usr/local/bin/claude',
        coreVersion: '2.0.1',
      },
      warnings: [],
    });
  });

  it('sends ONE remote script, wrapped in sh -c, after -- and the destination', async () => {
    const { proc } = await runPreflight(facts(DIRECT_FACTS));
    expect(proc.calls).toHaveLength(1);
    const argv = proc.calls[0]!.args;
    expect(argv.at(-3)).toBe('--');
    expect(argv.at(-2)).toBe('karst@devbox.example.com');
    const command = argv.at(-1)!;
    expect(command.startsWith("sh -c '")).toBe(true);
    // The mkdir/stat/df probes are inside that one script.
    expect(command).toContain('# karst-ssh-preflight');
    expect(command).toContain('mkdir -p -m 0700');
    expect(command).toContain('stat -c');
    expect(command).toContain('%u %a');
    expect(command).toContain('df -Pk');
    expect(command).toContain('uname -s');
  });

  it('passes the 30 s bound as an abort signal and a stdout cap to the seam', async () => {
    const seen: { signal?: AbortSignal; maxStdoutBytes?: number } = {};
    const proc = fakeSshProcess({ 'karst-ssh-preflight': { stdout: facts(DIRECT_FACTS) } });
    const run = proc.run;
    const result = await sshPreflight(NAME, DIRECT, { ...proc, run: (args, opts) => {
      seen.signal = opts?.signal;
      seen.maxStdoutBytes = opts?.maxStdoutBytes;
      return run(args, opts);
    } }, OPTS);
    expect(result.ok).toBe(true);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal?.aborted).toBe(false);
    expect(seen.maxStdoutBytes).toBeGreaterThan(0);
  });
});

describe('sshPreflight · OS and versions', () => {
  it('fails a remote that is not Linux', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, os: 'Darwin' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: remote OS Darwin not supported' });
  });

  it('fails an unreadable OS as unknown', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, os: undefined }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: remote OS unknown not supported' });
  });

  it('fails git below MIN_SANDBOX_GIT', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, git: 'git version 2.30.2' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: git 2.30 < 2.42' });
  });

  it('fails when git is missing', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, git: undefined }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: git not found' });
  });

  it('fails when git prints nothing usable', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, git: 'not a git' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: git version unreadable (not a git)' });
  });

  it('fails node 16', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, node: 'v16.20.2' }));
    expect(result).toEqual({ ok: false, reason: `ssh devbox: node 16.20 < ${MIN_REMOTE_NODE}` });
  });

  it('accepts node 18.0 and node 22', async () => {
    for (const node of ['v18.0.0', 'v22.11.0']) {
      const { result } = await runPreflight(facts({ ...DIRECT_FACTS, node }));
      expect(result.ok).toBe(true);
    }
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, node: 'v18.0.0' }));
    expect(result.ok && result.facts.node).toBe('18.0.0');
  });

  it('compares node majors as numbers, so v9 is not newer than 18', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, node: 'v9.11.2' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: node 9.11 < 18' });
  });

  it('fails when node is missing', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, node: undefined }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: node not found' });
  });

  it('fails when node prints nothing usable', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, node: 'garbage' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: node version unreadable (garbage)' });
  });
});

describe('sshPreflight · required and optional remote tools', () => {
  it('fails without setsid', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, setsid: 'no', setsidW: 'no' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: setsid not found (install util-linux)' });
  });

  it('fails when setsid has no -w', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, setsidW: 'no' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: setsid has no -w (util-linux too old)' });
  });

  it('only warns without tmux', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, tmux: 'no' }));
    expect(result).toEqual({
      ok: true,
      facts: expect.objectContaining({ tmux: false }),
      warnings: ['ssh devbox: tmux not found; the agent stops when the connection drops (install tmux)'],
    });
  });

  it('treats an odd tmux answer as not installed (fail closed)', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, tmux: 'maybe' }));
    expect(result.ok && result.warnings).toEqual([
      'ssh devbox: tmux not found; the agent stops when the connection drops (install tmux)',
    ]);
  });

  it('treats an odd setsid answer as missing (fail closed)', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, setsid: 'maybe' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: setsid not found (install util-linux)' });
  });
});

describe('sshPreflight · remoteDir', () => {
  it('fails a directory owned by another user', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, remoteDirStat: '1001 700' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: remoteDir /srv/karst is not private' });
  });

  it('fails a group- or world-writable directory', async () => {
    for (const stat of ['1000 770', '1000 707', '1000 777']) {
      const { result } = await runPreflight(facts({ ...DIRECT_FACTS, remoteDirStat: stat }));
      expect(result).toEqual({ ok: false, reason: 'ssh devbox: remoteDir /srv/karst is not private' });
    }
  });

  it('fails a missing or symlinked directory (no stat line)', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, remoteDirStat: undefined }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: remoteDir /srv/karst is not private' });
  });

  it('fails a stat line that does not have exactly an owner and a mode', async () => {
    for (const stat of ['1000', '1000 700 x', 'karst 700', '1000 800']) {
      const { result } = await runPreflight(facts({ ...DIRECT_FACTS, remoteDirStat: stat }));
      expect(result).toEqual({ ok: false, reason: 'ssh devbox: remoteDir /srv/karst is not private' });
    }
  });

  it('accepts 0755: readable by others is not writable by them', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, remoteDirStat: '1000 755' }));
    expect(result.ok).toBe(true);
  });
});

describe('sshPreflight · free disk', () => {
  it('fails below MIN_REMOTE_FREE_MB', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, freeKb: '1048576' }));
    expect(result).toEqual({
      ok: false,
      reason: `ssh devbox: 1024 MB free in /srv/karst, need ${MIN_REMOTE_FREE_MB} MB`,
    });
  });

  it('warns below WARN_REMOTE_FREE_MB but keeps going', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, freeKb: '4194304' }));
    expect(result).toEqual({
      ok: true,
      facts: expect.objectContaining({ freeMb: 4096 }),
      warnings: ['ssh devbox: low disk (4096 MB free in /srv/karst)'],
    });
    expect(WARN_REMOTE_FREE_MB).toBeGreaterThan(MIN_REMOTE_FREE_MB);
  });

  it('warns (never passes silently) when df is unreadable', async () => {
    for (const freeKb of [undefined, 'n/a']) {
      const { result } = await runPreflight(facts({ ...DIRECT_FACTS, freeKb }));
      expect(result).toEqual({
        ok: true,
        facts: expect.objectContaining({ freeMb: null }),
        warnings: ['ssh devbox: cannot read free disk in /srv/karst'],
      });
    }
  });

  it('reads df -Pk kilobytes, never as megabytes', async () => {
    // 2_000_000 KiB is 1953 MB: below the minimum, though 2_000_000 > MIN_REMOTE_FREE_MB.
    const low = await runPreflight(facts({ ...DIRECT_FACTS, freeKb: '2000000' }));
    expect(low.result).toEqual({
      ok: false,
      reason: `ssh devbox: 1953 MB free in /srv/karst, need ${MIN_REMOTE_FREE_MB} MB`,
    });
    // 3_000_000 KiB is 2929 MB: above the minimum, below the warning level.
    const warn = await runPreflight(facts({ ...DIRECT_FACTS, freeKb: '3000000' }));
    expect(warn.result).toEqual({
      ok: true,
      facts: expect.objectContaining({ freeMb: 2929 }),
      warnings: ['ssh devbox: low disk (2929 MB free in /srv/karst)'],
    });
  });

  it('reports both the tmux and the low-disk warning', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, tmux: 'no', freeKb: '4194304' }));
    expect(result.ok && result.warnings).toEqual([
      'ssh devbox: tmux not found; the agent stops when the connection drops (install tmux)',
      'ssh devbox: low disk (4096 MB free in /srv/karst)',
    ]);
  });
});

describe('sshPreflight · sshd forwarding fact', () => {
  it('reports AllowTcpForwarding when sshd -T was readable', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, allowTcpForwarding: 'no' }));
    expect(result.ok && result.facts.allowTcpForwarding).toBe('no');
  });

  it('falls back to unknown, never a guess, when it was not', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, allowTcpForwarding: undefined }));
    expect(result.ok && result.facts.allowTcpForwarding).toBe('unknown');
  });

  it('does not trust a non-forwarding value', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, allowTcpForwarding: 'yes; rm -rf /' }));
    expect(result.ok && result.facts.allowTcpForwarding).toBe('unknown');
  });
});

describe('sshPreflight · docker mode', () => {
  it('probes the remote docker server version', async () => {
    const { result } = await runPreflight(facts(DOCKER_FACTS), OPTS, DOCKER);
    expect(result).toEqual({
      ok: true,
      facts: expect.objectContaining({ docker: '29.1.3' }),
      warnings: [],
    });
  });

  it('has no core facts in docker mode', async () => {
    const { result } = await runPreflight(facts(DOCKER_FACTS), OPTS, DOCKER);
    expect(result.ok && 'coreBin' in result.facts).toBe(false);
  });

  it('fails when docker is not installed', async () => {
    const { result } = await runPreflight(facts({ ...DOCKER_FACTS, docker: undefined, dockerExit: '127' }), OPTS, DOCKER);
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: docker not found' });
  });

  it('fails when the docker daemon does not answer', async () => {
    const { result } = await runPreflight(facts({ ...DOCKER_FACTS, docker: undefined, dockerExit: '1' }), OPTS, DOCKER);
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: docker daemon not reachable' });
  });

  it('fails a docker server that answers with nothing', async () => {
    const { result } = await runPreflight(facts({ ...DOCKER_FACTS, docker: undefined }), OPTS, DOCKER);
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: docker daemon not reachable' });
  });
});

describe('sshPreflight · direct mode core', () => {
  it('fails when the session core binary is missing', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, coreBin: undefined, coreVersion: undefined }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: claude not found' });
  });

  it('fails when the session core cannot print a version', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, coreVersion: undefined }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: claude --version failed' });
  });

  it('names the session core it probed', async () => {
    const { proc } = await runPreflight(facts({ ...DIRECT_FACTS, coreBin: '/opt/oc2', coreVersion: '2.0.27' }), { ...OPTS, core: 'opencode2' });
    const command = proc.calls[0]!.args.at(-1)!;
    expect(command).toContain("command -v '\\''opencode2'\\''");
  });
});

describe('sshPreflight · transport failures', () => {
  it('names an unknown host key with what the user must run', async () => {
    const { result } = await runPreflight('', OPTS, DIRECT, {
      code: 255,
      transport: true,
      stderr: 'Host key verification failed.\n',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'ssh devbox: host key not trusted (run ssh karst@devbox.example.com once and accept the key)',
    });
  });

  it('detects the strict-checking "no host key is known" form', async () => {
    const { result } = await runPreflight('', OPTS, DIRECT, {
      code: 255,
      transport: true,
      stderr: 'No ED25519 host key is known for devbox.example.com and you have requested strict checking.\n',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'ssh devbox: host key not trusted (run ssh karst@devbox.example.com once and accept the key)',
    });
  });

  it('fails every other 255 with the tail of stderr', async () => {
    const { result } = await runPreflight('', OPTS, DIRECT, {
      code: 255,
      transport: true,
      stderr: 'Warning: Permanently added...\nPermission denied (publickey).\n',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'ssh devbox: ssh transport failed: Permission denied (publickey).',
    });
  });

  it('caps the stderr tail it carries into a reason', async () => {
    const long = 'x'.repeat(300);
    const { result } = await runPreflight('', OPTS, DIRECT, { code: 255, transport: true, stderr: `${long}\n` });
    expect(result).toEqual({ ok: false, reason: `ssh devbox: ssh transport failed: ${'x'.repeat(200)}` });
  });

  it('fails a 255 with empty stderr without a dangling separator', async () => {
    const { result } = await runPreflight('', OPTS, DIRECT, { code: 255, transport: true, stderr: '\n' });
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: ssh transport failed' });
  });

  it('fails when the ssh binary itself is missing', async () => {
    const { result } = await runPreflight('', OPTS, DIRECT, { code: 127, stderr: 'spawn ssh ENOENT' });
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: ssh not found (install openssh-client)' });
  });

  it('fails a nonzero script exit with its tail', async () => {
    const { result } = await runPreflight('', OPTS, DIRECT, { code: 2, stderr: 'sh: 1: printf: I/O error\n' });
    expect(result).toEqual({
      ok: false,
      reason: 'ssh devbox: preflight failed (exit 2): sh: 1: printf: I/O error',
    });
  });

  it('turns a rejecting seam into a reason', async () => {
    const proc: SshProcess = {
      run: () => Promise.reject(new Error('EPERM')),
      runWithStdin: () => Promise.reject(new Error('unused')),
      pipe: () => Promise.reject(new Error('unused')),
      spawnStream: () => { throw new Error('unused'); },
    };
    await expect(sshPreflight(NAME, DIRECT, proc, OPTS)).resolves.toEqual({
      ok: false,
      reason: 'ssh devbox: preflight failed: EPERM',
    });
  });
});

describe('sshPreflight · the 30 s bound', () => {
  it('resolves with a reason instead of hanging, and aborts the seam', async () => {
    let signal: AbortSignal | undefined;
    const hanging: SshProcess = {
      run: (_args, opts) => new Promise((_resolve, reject) => {
        signal = opts?.signal;
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      runWithStdin: () => Promise.reject(new Error('unused')),
      pipe: () => Promise.reject(new Error('unused')),
      spawnStream: () => { throw new Error('unused'); },
    };
    const result = await sshPreflight(NAME, DIRECT, hanging, { ...OPTS, timeoutMs: 10 });
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: preflight timed out' });
    expect(signal?.aborted).toBe(true);
  });
});

describe('sshPreflight · the remote output is untrusted', () => {
  it('ignores junk lines, duplicates and values with = in them', async () => {
    const stdout = [
      'garbage with no separator',
      '=no-key',
      'os=Linux',
      'uid=1000',
      'uid=0',
      'gid=1000',
      'git=git version 2.47.3',
      'setsid=yes',
      'setsidW=yes',
      'tmux=yes',
      'node=v22.11.0',
      'remoteDirStat=1000 700',
      'allowTcpForwarding=yes',
      'freeKb=52428800',
      'coreBin=/usr/bin/claude',
      'coreVersion=2.0.1 (Claude Code) extra=stuff',
    ].join('\n');
    const { result } = await runPreflight(`${stdout}\n`);
    expect(result).toEqual({
      ok: true,
      facts: expect.objectContaining({ uid: 1000, coreVersion: '2.0.1 (Claude Code) extra=stuff' }),
      warnings: [],
    });
  });

  it('fails closed on a missing uid', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, uid: undefined }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: preflight did not report a uid' });
  });

  it('fails closed on a non-numeric uid', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, uid: '0; id' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: preflight did not report a uid' });
  });

  it('fails closed on a uid that is not a safe integer', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, uid: '99999999999999999999' }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: preflight did not report a uid' });
  });

  it('fails closed on a missing gid', async () => {
    const { result } = await runPreflight(facts({ ...DIRECT_FACTS, gid: undefined }));
    expect(result).toEqual({ ok: false, reason: 'ssh devbox: preflight did not report a gid' });
  });
});
