import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireTrustLock,
  codexProjectHeader,
  codexProjectHeaderForKey,
  ensureClaudeWorkspaceTrusted,
  ensureCodexWorkspaceTrusted,
  mergeClaudeTrust,
  mergeCodexTrustToml,
  releaseTrustLock,
  repositoryRootFor,
  trustKeyFor,
  trustKeysFor,
  trustLockPath,
} from './workspaceTrust.js';

const cleanups: (() => void)[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-trust-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('trustKeyFor', () => {
  it('resolves a relative path to its absolute realpath', () => {
    const dir = tempDir();
    expect(trustKeyFor(join(dir, '.'))).toBe(trustKeyFor(dir));
    expect(trustKeyFor(dir).startsWith('/')).toBe(true);
  });

  it('returns the realpath of a symlinked directory, not the symlink', () => {
    const real = tempDir();
    const linkParent = tempDir();
    const link = join(linkParent, 'link');
    symlinkSync(real, link);
    expect(trustKeyFor(link)).toBe(trustKeyFor(real));
    expect(trustKeyFor(link)).not.toBe(link);
  });

  it('falls back to the absolute path for a directory that does not exist', () => {
    const dir = join(tempDir(), 'does-not-exist');
    // resolve() makes it absolute; there is no realpath to resolve.
    expect(trustKeyFor(dir)).toBe(dir);
  });
});

describe('trustKeysFor / repositoryRootFor', () => {
  /** A repo whose `.git` is a DIRECTORY (a normal clone), with a subdirectory. */
  function repoWithSubdir(): { repo: string; sub: string } {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    const sub = join(repo, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    return { repo, sub };
  }

  it('adds the repository root when the cwd is a subdirectory of a repo', () => {
    const { repo, sub } = repoWithSubdir();
    expect(repositoryRootFor(trustKeyFor(sub))).toBe(trustKeyFor(repo));
    // cwd first (codex keys on it), then the root Claude actually reads.
    expect(trustKeysFor(sub)).toEqual([trustKeyFor(sub), trustKeyFor(repo)]);
  });

  it('resolves a linked worktree to the MAIN worktree root', () => {
    const main = tempDir();
    mkdirSync(join(main, '.git'));
    const worktree = join(tempDir(), 'wt');
    mkdirSync(worktree);
    // A linked worktree's `.git` is a FILE pointing at the common dir.
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    const sub = join(worktree, 'sub');
    mkdirSync(sub);
    expect(repositoryRootFor(trustKeyFor(sub))).toBe(trustKeyFor(main));
    expect(trustKeysFor(sub)).toEqual([trustKeyFor(sub), trustKeyFor(main)]);
  });

  it('returns only the cwd when it is not inside a repo', () => {
    const dir = tempDir();
    expect(repositoryRootFor(trustKeyFor(dir))).toBeUndefined();
    expect(trustKeysFor(dir)).toEqual([trustKeyFor(dir)]);
  });

  it('returns only the cwd for a directory that does not exist', () => {
    const dir = join(tempDir(), 'does-not-exist');
    expect(trustKeysFor(dir)).toEqual([dir]);
  });
});

describe('mergeClaudeTrust', () => {
  it('creates a minimal document for a missing file', () => {
    const key = trustKeyFor('/karst/ticket-worktree');
    expect(mergeClaudeTrust(undefined, '/karst/ticket-worktree')).toEqual({
      changed: true,
      next: { projects: { [key]: { hasTrustDialogAccepted: true } } },
    });
  });

  it('preserves every other top-level key and the existing project entry', () => {
    const key = trustKeyFor('/karst/ticket-worktree');
    const existing = {
      numStartups: 12,
      projects: {
        [key]: { allowedTools: ['Read'], lastCost: 1.5 },
        '/other': { hasTrustDialogAccepted: true },
      },
    };
    const merged = mergeClaudeTrust(existing, '/karst/ticket-worktree');
    expect(merged.changed).toBe(true);
    expect(merged.next).toEqual({
      numStartups: 12,
      projects: {
        [key]: { allowedTools: ['Read'], lastCost: 1.5, hasTrustDialogAccepted: true },
        '/other': { hasTrustDialogAccepted: true },
      },
    });
  });

  it('is idempotent when the directory is already trusted', () => {
    const key = trustKeyFor('/karst/ticket-worktree');
    const existing = { projects: { [key]: { hasTrustDialogAccepted: true } } };
    const merged = mergeClaudeTrust(existing, '/karst/ticket-worktree');
    expect(merged).toEqual({ changed: false, next: existing });
  });

  it('leaves a top-level shape it cannot merge alone', () => {
    expect(mergeClaudeTrust([], '/wt')).toEqual({ changed: false, next: [] });
    expect(mergeClaudeTrust(null, '/wt')).toEqual({ changed: false, next: null });
    expect(mergeClaudeTrust('nope', '/wt')).toEqual({ changed: false, next: 'nope' });
  });

  it('records trust for both the cwd and the repository root (T661 UAT, medium)', () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    const sub = join(repo, 'pkg');
    mkdirSync(sub);
    expect(mergeClaudeTrust(undefined, sub).next).toEqual({
      projects: {
        [trustKeyFor(sub)]: { hasTrustDialogAccepted: true },
        [trustKeyFor(repo)]: { hasTrustDialogAccepted: true },
      },
    });
  });

  it('keeps existing project fields while adding the missing repository-root key', () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    const sub = join(repo, 'pkg');
    mkdirSync(sub);
    const existing = {
      projects: { [trustKeyFor(sub)]: { allowedTools: ['Read'], hasTrustDialogAccepted: true } },
    };
    const merged = mergeClaudeTrust(existing, sub);
    expect(merged.changed).toBe(true);
    expect(merged.next).toEqual({
      projects: {
        [trustKeyFor(sub)]: { allowedTools: ['Read'], hasTrustDialogAccepted: true },
        [trustKeyFor(repo)]: { hasTrustDialogAccepted: true },
      },
    });
  });

  it('is idempotent once both the cwd and the repository root are trusted', () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    const sub = join(repo, 'pkg');
    mkdirSync(sub);
    const existing = {
      projects: {
        [trustKeyFor(sub)]: { hasTrustDialogAccepted: true },
        [trustKeyFor(repo)]: { hasTrustDialogAccepted: true },
      },
    };
    expect(mergeClaudeTrust(existing, sub)).toEqual({ changed: false, next: existing });
  });
});

describe('ensureClaudeWorkspaceTrusted', () => {
  it('creates ~/.claude.json when it does not exist', () => {
    const home = tempDir();
    ensureClaudeWorkspaceTrusted('/karst/wt', { home });
    const parsed = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(parsed.projects[trustKeyFor('/karst/wt')]?.hasTrustDialogAccepted).toBe(true);
  });

  it('merges into a real config without dropping anything', () => {
    const home = tempDir();
    const path = join(home, '.claude.json');
    const key = trustKeyFor('/karst/wt');
    writeFileSync(path, JSON.stringify({ numStartups: 3, projects: { '/other': {} } }));
    ensureClaudeWorkspaceTrusted('/karst/wt', { home });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      numStartups: number;
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(parsed.numStartups).toBe(3);
    expect(parsed.projects['/other']).toEqual({});
    expect(parsed.projects[key]?.hasTrustDialogAccepted).toBe(true);
  });

  it('refuses to overwrite invalid JSON and continues the launch', () => {
    const home = tempDir();
    const path = join(home, '.claude.json');
    writeFileSync(path, '{ not valid json');
    const logs: string[] = [];
    expect(() => ensureClaudeWorkspaceTrusted('/karst/wt', { home, debug: (m) => logs.push(m) })).not.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{ not valid json');
    expect(logs.join('\n')).toMatch(/not valid JSON/);
  });

  it('skips the write (no reformat) when already trusted', () => {
    const home = tempDir();
    const path = join(home, '.claude.json');
    const key = trustKeyFor('/karst/wt');
    // Compact formatting proves a rewrite would change the bytes.
    const body = `{"projects":{"${key}":{"hasTrustDialogAccepted":true}}}`;
    writeFileSync(path, body);
    ensureClaudeWorkspaceTrusted('/karst/wt', { home });
    expect(readFileSync(path, 'utf8')).toBe(body);
  });

  it('leaves no temporary or lock file behind', () => {
    const home = tempDir();
    ensureClaudeWorkspaceTrusted('/karst/wt', { home });
    expect(readdirSync(home).filter((f) => f.includes('.tmp') || f.endsWith('.lock'))).toEqual([]);
  });

  it('skips the write while another live process holds the lock', async () => {
    const home = tempDir();
    const path = join(home, '.claude.json');
    writeFileSync(path, JSON.stringify({ projects: {} }));
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: 999_999, startedAt: Date.now(), nonce: 'o' }));
    const logs: string[] = [];
    // A fast clock makes the bounded wait return immediately.
    let t = 0;
    const now = (): number => (t += 100_000);
    await ensureClaudeWorkspaceTrusted('/karst/wt', {
      home,
      debug: (m) => logs.push(m),
      lock: { alive: () => true, now, sleep: () => {} },
    });
    expect((JSON.parse(readFileSync(path, 'utf8')) as { projects: unknown }).projects).toEqual({});
    expect(logs.join('\n')).toMatch(/trust lock busy/);
  });

  it('is fully synchronous (returns void) when the lock is free', () => {
    const home = tempDir();
    expect(ensureClaudeWorkspaceTrusted('/karst/wt', { home })).toBeUndefined();
  });

  it('returns a Promise (never blocks the loop) when the lock is contended', async () => {
    const home = tempDir();
    const path = join(home, '.claude.json');
    writeFileSync(path, JSON.stringify({ projects: {} }));
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: 999_999, startedAt: Date.now(), nonce: 'o' }));
    let t = 0;
    const now = (): number => (t += 100_000);
    const result = ensureClaudeWorkspaceTrusted('/karst/wt', {
      home,
      lock: { alive: () => true, now, sleep: () => {} },
    });
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('logs and continues when the lock cannot be taken (best-effort)', () => {
    const dir = tempDir();
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const logs: string[] = [];
    // `home` sits under a FILE, so creating the lock directory throws.
    expect(() =>
      ensureClaudeWorkspaceTrusted('/karst/wt', {
        home: join(blocker, 'home'),
        debug: (m) => logs.push(m),
      }),
    ).not.toThrow();
    expect(logs.join('\n')).toMatch(/cannot take the trust lock/);
  });

  it('writes through a symlinked config instead of replacing the link', () => {
    const home = tempDir();
    const target = join(tempDir(), 'claude.json');
    writeFileSync(target, JSON.stringify({ projects: {} }));
    symlinkSync(target, join(home, '.claude.json'));
    ensureClaudeWorkspaceTrusted('/karst/wt', { home });
    expect(lstatSync(join(home, '.claude.json')).isSymbolicLink()).toBe(true);
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(parsed.projects[trustKeyFor('/karst/wt')]?.hasTrustDialogAccepted).toBe(true);
  });

  it('records the repository-root key for a launch cwd inside a repo', () => {
    const home = tempDir();
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    const sub = join(repo, 'pkg');
    mkdirSync(sub);
    ensureClaudeWorkspaceTrusted(sub, { home });
    const parsed = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(parsed.projects[trustKeyFor(repo)]?.hasTrustDialogAccepted).toBe(true);
    expect(parsed.projects[trustKeyFor(sub)]?.hasTrustDialogAccepted).toBe(true);
  });
});

describe('trust lock', () => {
  it('acquires a free lock, then releases its own', async () => {
    const path = join(tempDir(), '.claude.json');
    expect(await acquireTrustLock(path)).toBe(true);
    expect(existsSync(trustLockPath(path))).toBe(true);
    releaseTrustLock(path);
    expect(existsSync(trustLockPath(path))).toBe(false);
  });

  it('refuses a lock a LIVE other process holds (bounded wait, then false)', async () => {
    const path = join(tempDir(), '.claude.json');
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: 999_999, startedAt: Date.now(), nonce: 'o' }));
    let t = 0;
    const now = (): number => (t += 100_000);
    expect(await acquireTrustLock(path, { alive: () => true, now, sleep: () => {} })).toBe(false);
  });

  it('takes over a lock whose owner died', async () => {
    const path = join(tempDir(), '.claude.json');
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: 999_999, startedAt: Date.now(), nonce: 'o' }));
    expect(await acquireTrustLock(path, { alive: () => false })).toBe(true);
    expect(JSON.parse(readFileSync(trustLockPath(path), 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('then takes over a lock we already held (crashed re-entry)', async () => {
    const path = join(tempDir(), '.claude.json');
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce: 'old' }));
    expect(await acquireTrustLock(path)).toBe(true);
  });

  it('a takeover never deletes a live lock a racer linked in meanwhile (restore beats link+rm)', async () => {
    const path = join(tempDir(), '.claude.json');
    const lock = trustLockPath(path);
    const rec = (pid: number, nonce: string): string =>
      JSON.stringify({ pid, startedAt: Date.now(), nonce });
    writeFileSync(lock, rec(111, 'dead'));
    const alive = (pid: number): boolean => {
      if (pid === 111) {
        // C replaces the stale lock between B's judgement and B's move.
        writeFileSync(`${lock}.c`, rec(222, 'c'));
        renameSync(`${lock}.c`, lock);
        return false;
      }
      // D links in while C's lock is moved aside.
      if (!existsSync(lock)) writeFileSync(lock, rec(333, 'd'));
      return true;
    };
    let t = 0;
    const now = (): number => (t += 100);
    expect(await acquireTrustLock(path, { alive, now, sleep: () => {} })).toBe(false);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: 222, nonce: 'c' });
  });

  it('a missing lock is retried, not treated as stale', async () => {
    const path = join(tempDir(), '.claude.json');
    const lock = trustLockPath(path);
    writeFileSync(lock, JSON.stringify({ pid: 999_999, startedAt: Date.now(), nonce: 'o' }));
    // The holder releases right after the waiter judged it live.
    const alive = (): boolean => {
      rmSync(lock, { force: true });
      return true;
    };
    expect(await acquireTrustLock(path, { alive, sleep: () => {} })).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('release never removes a lock another process owns', () => {
    const path = join(tempDir(), '.claude.json');
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: 999_999, startedAt: Date.now(), nonce: 'o' }));
    releaseTrustLock(path);
    expect(existsSync(trustLockPath(path))).toBe(true);
  });
});

describe('mergeCodexTrustToml', () => {
  it('appends a projects table when the directory is absent', () => {
    const existing = 'model = "gpt"\n';
    const merged = mergeCodexTrustToml(existing, '/karst/wt');
    expect(merged.changed).toBe(true);
    expect(merged.text).toBe(`model = "gpt"\n\n${codexProjectHeader('/karst/wt')}\ntrust_level = "trusted"\n`);
  });

  it('is idempotent when the directory is already trusted', () => {
    const existing = `${codexProjectHeader('/karst/wt')}\ntrust_level = "trusted"\n`;
    expect(mergeCodexTrustToml(existing, '/karst/wt')).toEqual({ changed: false, text: existing });
  });

  it('replaces an untrusted value inside the table while keeping its other keys', () => {
    const existing = [
      '[projects."/karst/wt"]',
      'name = "my project"',
      'trust_level = "untrusted"',
      '',
      '[tui]',
      'status_line = []',
      '',
    ].join('\n');
    const merged = mergeCodexTrustToml(existing, '/karst/wt');
    expect(merged.changed).toBe(true);
    expect(merged.text).toContain('name = "my project"\ntrust_level = "trusted"');
    expect(merged.text).toContain('[tui]\nstatus_line = []');
    expect(merged.text).not.toContain('untrusted');
  });

  it('matches a single-quoted table header', () => {
    const existing = `[projects.'/karst/wt']\ntrust_level = "trusted"\n`;
    expect(mergeCodexTrustToml(existing, '/karst/wt').changed).toBe(false);
  });

  it('recognises a header with a trailing comment — no duplicate table', () => {
    const existing = '[projects."/karst/wt"] # my project\ntrust_level = "untrusted"\n';
    const merged = mergeCodexTrustToml(existing, '/karst/wt');
    expect(merged.changed).toBe(true);
    expect(merged.text.match(/\[projects\."\/karst\/wt"\]/g)).toHaveLength(1);
    expect(merged.text).toContain('trust_level = "trusted"');
    expect(merged.text).not.toContain('untrusted');
  });

  it('recognises a header with inner whitespace — no duplicate table', () => {
    const existing = '[ projects."/karst/wt" ]\ntrust_level = "untrusted"\n';
    const merged = mergeCodexTrustToml(existing, '/karst/wt');
    expect(merged.text.match(/projects/g)).toHaveLength(1);
    expect(merged.text).toContain('trust_level = "trusted"');
  });

  it('keeps a trailing comment when it replaces trust_level', () => {
    const existing = '[projects."/karst/wt"]\ntrust_level = "untrusted" # keep me\n';
    expect(mergeCodexTrustToml(existing, '/karst/wt').text).toContain(
      'trust_level = "trusted" # keep me',
    );
  });

  it('writes a table for both the cwd and the repository root', () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    const sub = join(repo, 'pkg');
    mkdirSync(sub);
    const merged = mergeCodexTrustToml('model = "x"\n', sub);
    expect(merged.text).toContain(
      `${codexProjectHeaderForKey(trustKeyFor(sub))}\ntrust_level = "trusted"`,
    );
    expect(merged.text).toContain(
      `${codexProjectHeaderForKey(trustKeyFor(repo))}\ntrust_level = "trusted"`,
    );
  });

  it('does not mistake an array element for the next table header', () => {
    const existing = [
      '[projects."/karst/wt"]',
      'name = "proj"',
      'matrix = [',
      '[1,2],',
      ']',
      '',
      '[tui]',
      'x = 1',
      '',
    ].join('\n');
    const merged = mergeCodexTrustToml(existing, '/karst/wt');
    expect(merged.changed).toBe(true);
    // trust_level sits after the header, and the array + next table are intact.
    expect(merged.text).toContain('[projects."/karst/wt"]\ntrust_level = "trusted"\nname = "proj"');
    expect(merged.text).toContain('matrix = [\n[1,2],\n]');
    expect(merged.text).toContain('[tui]\nx = 1');
  });
});

describe('ensureCodexWorkspaceTrusted', () => {
  it('creates ~/.codex/config.toml and trusts the directory', () => {
    const home = tempDir();
    ensureCodexWorkspaceTrusted('/karst/wt', { home });
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(text).toContain(`${codexProjectHeader('/karst/wt')}\ntrust_level = "trusted"`);
    // No temporary or lock file survives the write.
    expect(
      readdirSync(join(home, '.codex')).filter((f) => f.includes('.tmp') || f.endsWith('.lock')),
    ).toEqual([]);
  });

  it('writes through a symlinked config instead of replacing the link', () => {
    const home = tempDir();
    const target = join(tempDir(), 'config.toml');
    writeFileSync(target, 'model = "x"\n');
    mkdirSync(join(home, '.codex'), { recursive: true });
    symlinkSync(target, join(home, '.codex', 'config.toml'));
    ensureCodexWorkspaceTrusted('/karst/wt', { home });
    expect(lstatSync(join(home, '.codex', 'config.toml')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('trust_level = "trusted"');
  });

  it('preserves existing config content', () => {
    const home = tempDir();
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.toml'), 'model = "keep-me"\n');
    ensureCodexWorkspaceTrusted('/karst/wt', { home });
    const text = readFileSync(join(dir, 'config.toml'), 'utf8');
    expect(text).toContain('model = "keep-me"');
    expect(text).toContain('trust_level = "trusted"');
  });

  it('skips the write when already trusted', () => {
    const home = tempDir();
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const body = `${codexProjectHeader('/karst/wt')}\ntrust_level = "trusted"\n`;
    writeFileSync(join(dir, 'config.toml'), body);
    ensureCodexWorkspaceTrusted('/karst/wt', { home });
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe(body);
  });
});

describe('config dir overrides', () => {
  it('writes claude trust under $CLAUDE_CONFIG_DIR', () => {
    const home = tempDir();
    const dir = tempDir();
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    ensureClaudeWorkspaceTrusted('/karst/wt', {});
    expect(existsSync(join(dir, '.claude.json'))).toBe(true);
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
  });

  it('writes codex trust under $CODEX_HOME', () => {
    const home = tempDir();
    const dir = tempDir();
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEX_HOME', dir);
    ensureCodexWorkspaceTrusted('/karst/wt', {});
    expect(existsSync(join(dir, 'config.toml'))).toBe(true);
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('ignores an empty override and uses the home default', () => {
    const home = tempDir();
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    ensureClaudeWorkspaceTrusted('/karst/wt', {});
    expect(existsSync(join(home, '.claude.json'))).toBe(true);
  });
});

describe('config file permissions', () => {
  it('preserves an existing mode instead of widening it', () => {
    const home = tempDir();
    const path = join(home, '.claude.json');
    writeFileSync(path, JSON.stringify({ projects: {} }));
    chmodSync(path, 0o600);
    ensureClaudeWorkspaceTrusted('/karst/wt', { home });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('creates a new claude config 0600', () => {
    const home = tempDir();
    ensureClaudeWorkspaceTrusted('/karst/wt', { home });
    expect(statSync(join(home, '.claude.json')).mode & 0o777).toBe(0o600);
  });

  it('creates a new codex config 0600', () => {
    const home = tempDir();
    ensureCodexWorkspaceTrusted('/karst/wt', { home });
    expect(statSync(join(home, '.codex', 'config.toml')).mode & 0o777).toBe(0o600);
  });
});

describe('trust hook never throws', () => {
  /** A repo whose `.git` is a self-looping symlink: statSync throws ELOOP. */
  function loopingRepo(): string {
    const dir = tempDir();
    symlinkSync(join(dir, '.git'), join(dir, '.git'));
    return dir;
  }

  it('claude: a faulting .git logs and returns instead of throwing', () => {
    const home = tempDir();
    const logs: string[] = [];
    expect(() =>
      ensureClaudeWorkspaceTrusted(loopingRepo(), { home, debug: (m) => logs.push(m) }),
    ).not.toThrow();
    expect(logs.join('\n')).toContain('launch continues');
  });

  it('codex: a faulting .git logs and returns instead of throwing', () => {
    const home = tempDir();
    const logs: string[] = [];
    expect(() =>
      ensureCodexWorkspaceTrusted(loopingRepo(), { home, debug: (m) => logs.push(m) }),
    ).not.toThrow();
    expect(logs.join('\n')).toContain('launch continues');
  });
});
