import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  ensureClaudeWorkspaceTrusted,
  ensureCodexWorkspaceTrusted,
  mergeClaudeTrust,
  mergeCodexTrustToml,
  releaseTrustLock,
  trustKeyFor,
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

  it('skips the write while another live process holds the lock', () => {
    const home = tempDir();
    const path = join(home, '.claude.json');
    writeFileSync(path, JSON.stringify({ projects: {} }));
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: 999_999, startedAt: Date.now() }));
    const logs: string[] = [];
    // A fast clock makes the bounded wait return immediately.
    let t = 0;
    const now = (): number => (t += 100_000);
    ensureClaudeWorkspaceTrusted('/karst/wt', {
      home,
      debug: (m) => logs.push(m),
      lock: { alive: () => true, now, sleep: () => {} },
    });
    expect((JSON.parse(readFileSync(path, 'utf8')) as { projects: unknown }).projects).toEqual({});
    expect(logs.join('\n')).toMatch(/trust lock busy/);
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
});

describe('trust lock', () => {
  it('acquires a free lock, then releases its own', () => {
    const path = join(tempDir(), '.claude.json');
    expect(acquireTrustLock(path)).toBe(true);
    expect(existsSync(trustLockPath(path))).toBe(true);
    releaseTrustLock(path);
    expect(existsSync(trustLockPath(path))).toBe(false);
  });

  it('refuses a lock a LIVE other process holds (bounded wait, then false)', () => {
    const path = join(tempDir(), '.claude.json');
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: 999_999, startedAt: Date.now() }));
    let t = 0;
    const now = (): number => (t += 100_000);
    expect(acquireTrustLock(path, { alive: () => true, now, sleep: () => {} })).toBe(false);
  });

  it('takes over a lock whose owner died', () => {
    const path = join(tempDir(), '.claude.json');
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: 999_999, startedAt: Date.now() }));
    expect(acquireTrustLock(path, { alive: () => false })).toBe(true);
    expect(JSON.parse(readFileSync(trustLockPath(path), 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('then takes over a lock we already held (crashed re-entry)', () => {
    const path = join(tempDir(), '.claude.json');
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    expect(acquireTrustLock(path)).toBe(true);
  });

  it('release never removes a lock another process owns', () => {
    const path = join(tempDir(), '.claude.json');
    writeFileSync(trustLockPath(path), JSON.stringify({ pid: 999_999, startedAt: Date.now() }));
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
