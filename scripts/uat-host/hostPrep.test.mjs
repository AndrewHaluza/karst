import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareUserData, writeCliShims } from './hostPrep.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'karst-hostprep-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeCliShims', () => {
  it('writes the four no-op shims and no gh shim', () => {
    const shimDir = join(dir, 'shims');
    writeCliShims(shimDir, { gh: false });
    for (const cli of ['claude', 'codex', 'agy', 'opencode']) {
      const f = join(shimDir, cli);
      expect(readFileSync(f, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
      expect(statSync(f).mode & 0o777).toBe(0o755);
    }
    expect(existsSync(join(shimDir, 'gh'))).toBe(false);
  });
  it('writes the gh shim when asked', () => {
    const shimDir = join(dir, 'shims');
    writeCliShims(shimDir, { gh: true, nodePath: '/n/node', ghStubPath: '/s/ghStub.mjs' });
    const f = join(shimDir, 'gh');
    expect(readFileSync(f, 'utf8')).toBe('#!/bin/sh\nexec "/n/node" "/s/ghStub.mjs" "$@"\n');
    expect(statSync(f).mode & 0o777).toBe(0o755);
  });
  it('creates the dir and overwrites an existing shim', () => {
    const shimDir = join(dir, 'a', 'b');
    writeCliShims(shimDir, { gh: false });
    writeFileSync(join(shimDir, 'claude'), 'old');
    writeCliShims(shimDir, { gh: false });
    expect(readFileSync(join(shimDir, 'claude'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
  });
});

describe('prepareUserData', () => {
  it('creates the dirs, copies the settings and returns the paths', () => {
    const settings = join(dir, 'settings.src.json');
    writeFileSync(settings, '{"a":1}\n');
    const root = join(dir, 'root');
    const out = prepareUserData(root, settings);
    expect(out).toEqual({
      userData: join(root, 'user-data'),
      extensionsDir: join(root, 'extensions'),
      dbPath: join(root, 'user-data', 'User', 'globalStorage', 'karst.karst', 'karst.db'),
    });
    expect(existsSync(join(root, 'extensions'))).toBe(true);
    expect(readFileSync(join(root, 'user-data', 'User', 'settings.json'), 'utf8')).toBe('{"a":1}\n');
  });
});
