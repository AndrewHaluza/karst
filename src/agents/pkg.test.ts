import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgentFiles, readAgentFile, writeAgentFile, removeAgentFile, parseProfileContext, resolveProfileContext } from './pkg.js';

const dirs: string[] = [];

function makeAgentsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-agents-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('listAgentFiles', () => {
  it('returns [] when agentsDir does not exist', () => {
    const dir = join(tmpdir(), 'karst-agents-missing-' + Math.random().toString(36).slice(2));
    expect(listAgentFiles(dir)).toEqual([]);
  });

  it('lists .md files, skipping subdirs and non-.md files, sorted by name', () => {
    const dir = makeAgentsDir();
    writeAgentFile(dir, 'zeta', 'zeta body');
    writeAgentFile(dir, 'alpha', 'alpha body');
    // a subdir and a non-.md file should be skipped
    mkdirSync(join(dir, 'subdir'));
    writeFileSync(join(dir, 'notes.txt'), 'not an agent');

    const list = listAgentFiles(dir);
    expect(list.map((a) => a.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('write -> list -> read round-trip', () => {
  it('round-trips name, body, and parsed description from frontmatter', () => {
    const dir = makeAgentsDir();
    const body = '---\ndescription: "Reviews code carefully"\n---\nYou are a reviewer.';
    writeAgentFile(dir, 'reviewer', body);

    const list = listAgentFiles(dir);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('reviewer');
    expect(list[0]!.description).toBe('Reviews code carefully');
    expect(list[0]!.body).toBe(body);

    const read = readAgentFile(dir, 'reviewer');
    expect(read).not.toBeNull();
    expect(read!.name).toBe('reviewer');
    expect(read!.description).toBe('Reviews code carefully');
    expect(read!.body).toBe(body);
  });

  it('a file without frontmatter reads description === undefined, body intact', () => {
    const dir = makeAgentsDir();
    const body = 'Plain agent prompt, no frontmatter.';
    writeAgentFile(dir, 'plain', body);

    const read = readAgentFile(dir, 'plain');
    expect(read).not.toBeNull();
    expect(read!.description).toBeUndefined();
    expect(read!.body).toBe(body);
  });
});

describe('readAgentFile', () => {
  it('returns null when the file is absent', () => {
    const dir = makeAgentsDir();
    expect(readAgentFile(dir, 'ghost')).toBeNull();
  });
});

describe('writeAgentFile sanitization', () => {
  it('strips a dangerous frontmatter key before write', () => {
    const dir = makeAgentsDir();
    const body = '---\ndescription: danger\npermissionMode: bypassPermissions\n---\nBody text.';
    writeAgentFile(dir, 'danger', body);

    const read = readAgentFile(dir, 'danger');
    expect(read).not.toBeNull();
    expect(read!.body).not.toContain('permissionMode');
    expect(read!.body).not.toContain('bypassPermissions');

    const onDisk = readFileSync(join(dir, 'danger.md'), 'utf8');
    expect(onDisk).not.toContain('permissionMode');
  });
});

describe('writeAgentFile keeps user keys', () => {
  it('keeps model and tools, drops permission keys', () => {
    const dir = makeAgentsDir();
    writeAgentFile(dir, 'mine', '---\nname: mine\nmodel: opus\ntools: Read, Grep\npermissionMode: acceptEdits\n---\nB');
    const onDisk = readFileSync(join(dir, 'mine.md'), 'utf8');
    expect(onDisk).toBe('---\nname: mine\nmodel: opus\ntools: Read, Grep\n---\nB');
  });
});

describe('unsafe name guard', () => {
  it('throws on write for an unsafe name', () => {
    const dir = makeAgentsDir();
    expect(() => writeAgentFile(dir, '../evil', 'body')).toThrow();
    expect(() => writeAgentFile(dir, 'a/b', 'body')).toThrow();
    expect(() => writeAgentFile(dir, '/etc/passwd', 'body')).toThrow();
  });

  it('throws on read for an unsafe name', () => {
    const dir = makeAgentsDir();
    expect(() => readAgentFile(dir, '../evil')).toThrow();
    expect(() => readAgentFile(dir, 'a/b')).toThrow();
    expect(() => readAgentFile(dir, '/etc/passwd')).toThrow();
  });

  it('throws on remove for an unsafe name', () => {
    const dir = makeAgentsDir();
    expect(() => removeAgentFile(dir, '../evil')).toThrow();
    expect(() => removeAgentFile(dir, 'a/b')).toThrow();
    expect(() => removeAgentFile(dir, '/etc/passwd')).toThrow();
  });
});

describe('removeAgentFile', () => {
  it('is idempotent on an absent file and clears an existing one', () => {
    const dir = makeAgentsDir();
    expect(() => removeAgentFile(dir, 'nope')).not.toThrow();

    writeAgentFile(dir, 'temp', 'body');
    expect(readAgentFile(dir, 'temp')).not.toBeNull();

    removeAgentFile(dir, 'temp');
    expect(readAgentFile(dir, 'temp')).toBeNull();

    // idempotent: removing again does not throw
    expect(() => removeAgentFile(dir, 'temp')).not.toThrow();
  });
});

describe('parseProfileContext / resolveProfileContext', () => {
  const fm = (line: string): string => `---\ndescription: Reviews code\n${line}\n---\nBody`;

  it('no key = full context; context: minimal = minimal', () => {
    expect(parseProfileContext(fm('model: x'))).toEqual({});
    expect(parseProfileContext('no frontmatter')).toEqual({});
    expect(parseProfileContext(fm('context: minimal'))).toEqual({ context: 'minimal' });
    expect(parseProfileContext(fm('context: "minimal"'))).toEqual({ context: 'minimal' });
  });

  it('reads a CRLF profile', () => {
    expect(parseProfileContext('---\r\ncontext: minimal\r\n---\r\nBody')).toEqual({ context: 'minimal' });
  });

  it('an unknown value is reported, never minimal', () => {
    expect(parseProfileContext(fm('context: tiny'))).toEqual({ unknown: 'tiny' });
    expect(parseProfileContext(fm('context:'))).toEqual({ unknown: '' });
  });

  it('ignores nested keys and a key after an unterminated block', () => {
    expect(parseProfileContext('---\nmeta:\n  context: minimal\n---\n')).toEqual({});
    expect(parseProfileContext('---\ncontext: minimal\nBody')).toEqual({});
  });

  it('the key does not change the parsed description and survives sanitizeFrontmatter', () => {
    const dir = makeAgentsDir();
    writeAgentFile(dir, 'a', fm('context: minimal\npermissionMode: bypassPermissions'));
    const read = readAgentFile(dir, 'a')!;
    expect(read.description).toBe('Reviews code');
    expect(read.body).toContain('context: minimal');
    expect(read.body).not.toContain('permissionMode');
  });

  it('resolveProfileContext: minimal, none, unreadable (undefined body), unknown warns', () => {
    const warn = vi.fn();
    expect(resolveProfileContext('p', fm('context: minimal'), warn)).toBe('minimal');
    expect(resolveProfileContext('p', fm('x: y'), warn)).toBeUndefined();
    expect(resolveProfileContext('p', undefined, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(resolveProfileContext('p', fm('context: tiny'), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown `context: tiny`'));
    resolveProfileContext(undefined, fm('context: tiny'), warn);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('(unnamed)'));
  });
});
