import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupOwnedPaths } from './materializedCleanup.js';

describe('cleanupOwnedPaths', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('removes only explicit owned paths beneath the worktree', () => {
    root = mkdtempSync(join(tmpdir(), 'karst-cleanup-'));
    const owned = join(root, '.agents', 'skills', 'karst-rpi');
    const user = join(root, '.agents', 'skills', 'user-skill');
    mkdirSync(owned, { recursive: true });
    mkdirSync(user, { recursive: true });
    writeFileSync(join(owned, 'SKILL.md'), 'generated');
    writeFileSync(join(user, 'SKILL.md'), 'user');

    cleanupOwnedPaths(root, [owned]);

    expect(existsSync(owned)).toBe(false);
    expect(existsSync(user)).toBe(true);
  });

  it.each([
    '/tmp/outside',
    '../outside',
    '.agents/skills/user-skill',
    '.agents',
    '.codex',
  ])('rejects an unsafe cleanup target: %s', (target) => {
    root = mkdtempSync(join(tmpdir(), 'karst-cleanup-'));
    expect(() => cleanupOwnedPaths(root, [target])).toThrow(/owned path|unsafe/i);
  });
});
