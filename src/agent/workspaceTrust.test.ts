import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexProjectHeader,
  ensureClaudeWorkspaceTrusted,
  ensureCodexWorkspaceTrusted,
  mergeClaudeTrust,
  mergeCodexTrustToml,
  trustKeyFor,
} from './workspaceTrust.js';

const cleanups: (() => void)[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-trust-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
afterEach(() => {
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

  it('leaves no temporary file behind (atomic rename)', () => {
    const home = tempDir();
    ensureClaudeWorkspaceTrusted('/karst/wt', { home });
    expect(readdirSync(home).filter((f) => f.includes('.tmp'))).toEqual([]);
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
});

describe('ensureCodexWorkspaceTrusted', () => {
  it('creates ~/.codex/config.toml and trusts the directory', () => {
    const home = tempDir();
    ensureCodexWorkspaceTrusted('/karst/wt', { home });
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(text).toContain(`${codexProjectHeader('/karst/wt')}\ntrust_level = "trusted"`);
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
