import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import type { SshCore } from '../sandboxCores.js';
import { fakeSshProcess, type FakeSshProcess } from './fakeSshProcess.js';
import { remoteSh } from './sshQuote.js';
import { ensureRemoteWorkspaceTrusted, type RemoteTrustInput } from './sshTrust.js';

const REMOTE: RemoteDef = { host: 'devbox.example', user: 'nick', mode: 'direct', remoteDir: '/home/nick/.karst' };
const CONTROL_DIR = '/tmp/karst-ssh-501/';
const REMOTE_CWD = '/home/nick/.karst/karst-0a1b2c3d-7-claude/repo';

type Input = Omit<RemoteTrustInput, 'ssh'> & { readonly ssh: FakeSshProcess };

function input(over: Partial<Input> = {}): Input {
  return {
    ssh: fakeSshProcess(),
    remote: REMOTE,
    controlDir: CONTROL_DIR,
    core: 'claude' as SshCore,
    remoteCwd: REMOTE_CWD,
    ...over,
  };
}

/** `process.exit` inside a sent script stops it; this is how a test observes which branch ran. */
class ScriptExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Run a generated remote script IN-PROCESS against a temp `$HOME`, with only
 * `require('node:fs'|'node:path')` and a script-local `process` (so the
 * operator's real home is never touched). No child process: this stays a unit
 * test and still executes the real merge.
 */
function runScript(script: string, home: string): number {
  try {
    runInNewContext(script, {
      require: (id: string) => {
        if (id === 'node:fs') return nodeFs;
        if (id === 'node:path') return nodePath;
        throw new Error(`unexpected require(${id})`);
      },
      process: {
        env: { HOME: home },
        pid: process.pid,
        exit: (code?: number) => {
          throw new ScriptExit(code ?? 0);
        },
      },
    });
    return 0;
  } catch (error) {
    if (error instanceof ScriptExit) return error.code;
    throw error;
  }
}

const tempDirs: string[] = [];

function homeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-ssh-trust-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ensureRemoteWorkspaceTrusted', () => {
  it('sends the claude merge script over stdin, never on the argv', async () => {
    const opts = input();
    const warn = vi.fn();
    await ensureRemoteWorkspaceTrusted({ ...opts, warn });

    expect(opts.ssh.stdinCalls).toHaveLength(1);
    expect(opts.ssh.calls).toHaveLength(0);
    const call = opts.ssh.stdinCalls[0]!;
    expect(call.args.at(-1)).toBe(remoteSh('node -'));
    expect(call.args).toContain('--');
    const script = call.stdin.toString('utf8');
    expect(script).toContain('hasTrustDialogAccepted');
    expect(script).toContain(REMOTE_CWD);
    expect(script).toContain('.claude.json');
    // The path and the record shape are stdin content, never argv content.
    expect(call.args.join(' ')).not.toContain('hasTrustDialogAccepted');
    expect(call.args.join(' ')).not.toContain(REMOTE_CWD);
    expect(warn).not.toHaveBeenCalled();
  });

  it('sends the codex merge script with the exact TOML block and header', async () => {
    const opts = input({ core: 'codex' });
    await ensureRemoteWorkspaceTrusted(opts);
    const script = opts.ssh.stdinCalls[0]!.stdin.toString('utf8');
    expect(script).toContain('trust_level = "trusted"');
    expect(script).toContain('projects.');
    expect(script).toContain('config.toml');
    expect(opts.ssh.calls).toHaveLength(0);
  });

  it('an untrusted transport warns and does not throw', async () => {
    const ssh = fakeSshProcess({ 'node -': { code: 255, stderr: 'Host key verification failed.', transport: true } });
    const warn = vi.fn();
    await expect(ensureRemoteWorkspaceTrusted({ ...input({ ssh }), warn, remoteName: 'devbox' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Host key verification failed.'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("on 'devbox'"));
  });

  it('a rejected process call warns and does not throw', async () => {
    const ssh = fakeSshProcess();
    ssh.runWithStdin = () => Promise.reject(new Error('spawn ssh ENOENT'));
    const warn = vi.fn();
    await expect(ensureRemoteWorkspaceTrusted({ ...input({ ssh }), warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawn ssh ENOENT'));
  });

  it('a non-zero script exit warns with the exit code', async () => {
    const ssh = fakeSshProcess({ 'node -': { code: 1, stderr: '' } });
    const warn = vi.fn();
    await ensureRemoteWorkspaceTrusted({ ...input({ ssh }), warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exit 1'));
  });

  it('runs NO ssh for a core without a folder-trust prompt', async () => {
    for (const core of ['opencode', 'opencode2'] as const) {
      const opts = input({ core });
      const warn = vi.fn();
      await ensureRemoteWorkspaceTrusted({ ...opts, warn });
      expect(opts.ssh.stdinCalls).toHaveLength(0);
      expect(opts.ssh.calls).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('a no-op run (already trusted) is silent', async () => {
    const ssh = fakeSshProcess({ 'node -': { code: 0 } });
    const warn = vi.fn();
    const debug = vi.fn();
    await ensureRemoteWorkspaceTrusted({ ...input({ ssh }), warn, debug });
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('folder trust recorded'));
  });
});

describe('the generated claude script', () => {
  it('is valid JavaScript and merges the trust record into ~/.claude.json', async () => {
    const home = homeDir();
    const opts = input();
    await ensureRemoteWorkspaceTrusted(opts);
    const script = opts.ssh.stdinCalls[0]!.stdin.toString('utf8');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, projects: { '/other': { allowedTools: [] } } }));

    expect(runScript(script, home)).toBe(0);

    const doc = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      numStartups: number;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(doc.numStartups).toBe(3);
    expect(doc.projects[REMOTE_CWD]?.hasTrustDialogAccepted).toBe(true);
    expect(doc.projects['/other']).toEqual({ allowedTools: [] });
    // Idempotent: a second run leaves the file alone and exits with no write.
    expect(runScript(script, home)).toBe(0);
  });

  it('creates a fresh document when the file does not exist', async () => {
    const home = homeDir();
    const opts = input();
    await ensureRemoteWorkspaceTrusted(opts);
    expect(runScript(opts.ssh.stdinCalls[0]!.stdin.toString('utf8'), home)).toBe(0);
    const doc = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(doc.projects[REMOTE_CWD]?.hasTrustDialogAccepted).toBe(true);
    expect(nodeFs.statSync(join(home, '.claude.json')).mode & 0o777).toBe(0o600);
  });

  it('never overwrites a config it cannot parse', async () => {
    const home = homeDir();
    writeFileSync(join(home, '.claude.json'), '{not json');
    const opts = input();
    await ensureRemoteWorkspaceTrusted(opts);
    expect(runScript(opts.ssh.stdinCalls[0]!.stdin.toString('utf8'), home)).toBe(0);
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{not json');
  });
});

describe('the generated codex script', () => {
  async function codexScript(): Promise<string> {
    const opts = input({ core: 'codex' });
    await ensureRemoteWorkspaceTrusted(opts);
    return opts.ssh.stdinCalls[0]!.stdin.toString('utf8');
  }

  it('appends the trusted table to a fresh config', async () => {
    const home = homeDir();
    mkdirSync(join(home, '.codex'), { recursive: true });
    expect(runScript(await codexScript(), home)).toBe(0);
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(text).toContain(`[projects.${JSON.stringify(REMOTE_CWD)}]`);
    expect(text).toContain('trust_level = "trusted"');
  });

  it('keeps every other line and does not duplicate a single-quoted table', async () => {
    const home = homeDir();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      ['model = "gpt-5.1"', '', `[projects.'${REMOTE_CWD}']`, 'other = 1', ''].join('\n'),
    );
    expect(runScript(await codexScript(), home)).toBe(0);
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(text).toContain('model = "gpt-5.1"');
    expect(text.match(/\[projects\./g)).toHaveLength(1);
    expect(text).toContain('other = 1');
    expect(text).toContain('trust_level = "trusted"');
  });
});
