import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepInStage } from './stage-vsix.mjs';

// vsce lists a symlink to a directory as a file and its secretlint scan then
// reads it: `EISDIR: illegal operation on a directory, read`. The
// .agents/skills/<name> -> ../../.claude/skills/<name> links broke every build.
describe('keepInStage', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stage-filter-'));
    mkdirSync(join(dir, 'real-dir'));
    writeFileSync(join(dir, 'real-file.md'), 'x');
    symlinkSync(join(dir, 'real-dir'), join(dir, 'dir-link'));
    symlinkSync(join(dir, 'real-file.md'), join(dir, 'file-link.md'));
    symlinkSync(join(dir, 'missing'), join(dir, 'dangling-link'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('drops a symlink to a directory', () => {
    expect(keepInStage(join(dir, 'dir-link'))).toBe(false);
  });

  it('drops a dangling symlink', () => {
    expect(keepInStage(join(dir, 'dangling-link'))).toBe(false);
  });

  it('keeps a real directory, a real file and a symlink to a file', () => {
    expect(keepInStage(join(dir, 'real-dir'))).toBe(true);
    expect(keepInStage(join(dir, 'real-file.md'))).toBe(true);
    expect(keepInStage(join(dir, 'file-link.md'))).toBe(true);
  });
});
