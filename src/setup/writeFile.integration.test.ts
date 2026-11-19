import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWriteFilePatch } from './writeFile.js';

// The patch the host builds must be one that real git accepts and that yields the exact bytes.
let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'karst-wf-git-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function applyAndRead(path: string, content: string): string {
  const built = buildWriteFilePatch(repo, path, content);
  if (!built.ok) throw new Error(built.reason);
  execFileSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], { cwd: repo, input: built.patch });
  execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: repo, input: built.patch });
  return readFileSync(join(repo, path), 'utf8');
}

describe('write-file patch applies with git', () => {
  it.each([
    ['a new file', 'one\ntwo\n'],
    ['a new file with no final newline', 'one\ntwo'],
    ['CRLF content', 'a\r\nb\r\n'],
    ['a line that starts with + and -', '+x\n-y\n@@ z\n'],
  ])('creates %s', (_name, content) => {
    expect(applyAndRead('dir/f.txt', content)).toBe(content);
  });

  it('creates a new empty file', () => {
    expect(applyAndRead('.gitkeep', '')).toBe('');
  });

  it.each([
    ['old\n', 'new\n'],
    ['old', 'new\n'],
    ['old\n', 'new'],
    ['a\nb\nc\n', 'a\nB\nc\nd\n'],
    ['a\nb\n', ''],
    ['', 'filled\n'],
  ])('replaces %j with %j', (before, after) => {
    writeFileSync(join(repo, 'f.txt'), before);
    expect(applyAndRead('f.txt', after)).toBe(after);
  });
});
