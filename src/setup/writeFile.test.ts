import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SETUP_WRITE_CONTENT } from './proposal.js';
import { buildWriteFilePatch } from './writeFile.js';

let root: string;
let repo: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'karst-wf-'));
  repo = join(root, 'repo');
  outside = join(root, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const built = (path: string, content: string) => buildWriteFilePatch(repo, path, content);
const patchOf = (path: string, content: string): string => {
  const r = built(path, content);
  if (!r.ok) throw new Error(`expected a patch, got: ${r.reason}`);
  return r.patch;
};
const reasonOf = (path: string, content = 'x\n'): string => {
  const r = built(path, content);
  if (r.ok) throw new Error('expected a refusal');
  return r.reason;
};

describe('buildWriteFilePatch — build', () => {
  it('builds a new-file patch', () => {
    expect(patchOf('src/a.txt', 'one\ntwo\n')).toBe(
      'diff --git a/src/a.txt b/src/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    );
  });

  it('marks a new file with no final newline', () => {
    expect(patchOf('a.txt', 'one')).toBe(
      'diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+one\n\\ No newline at end of file\n',
    );
  });

  it('builds a header-only patch for a new empty file', () => {
    expect(patchOf('.gitkeep', '')).toBe('diff --git a/.gitkeep b/.gitkeep\nnew file mode 100644\n');
  });

  it('replaces the whole content of an existing file', () => {
    writeFileSync(join(repo, 'a.txt'), 'old1\nold2\n');
    expect(patchOf('a.txt', 'new\n')).toBe('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1 @@\n-old1\n-old2\n+new\n');
  });

  it('marks a missing final newline on each side', () => {
    writeFileSync(join(repo, 'a.txt'), 'old');
    expect(patchOf('a.txt', 'new\n')).toBe(
      'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n',
    );
  });

  it('keeps a carriage return as content', () => {
    expect(patchOf('a.txt', 'a\r\n')).toContain('+a\r\n');
  });

  it('refuses a write that changes nothing', () => {
    writeFileSync(join(repo, 'a.txt'), 'same\n');
    expect(reasonOf('a.txt', 'same\n')).toContain('already has this content');
  });

  it('refuses an existing binary file and a directory target', () => {
    writeFileSync(join(repo, 'b.bin'), Buffer.from([0, 1, 2]));
    expect(reasonOf('b.bin')).toContain('not a text file');
    mkdirSync(join(repo, 'dir'));
    expect(reasonOf('dir')).toContain('not a regular file');
  });

  it('refuses an existing file that is not valid text', () => {
    writeFileSync(join(repo, 'b.txt'), Buffer.from([0xff, 0xfe, 0x41]));
    expect(reasonOf('b.txt')).toContain('not a text file');
  });
});

describe('buildWriteFilePatch — refusals', () => {
  it('refuses a path outside the repo, absolute or with ..', () => {
    expect(reasonOf('../outside/x')).toContain('path');
    expect(reasonOf('/etc/x')).toContain('path');
  });

  it.each(['.karst/karst.yml', '.KARST/x', 'a/.karst/x'])('refuses %s under .karst/', (path) => {
    expect(reasonOf(path)).toContain('.karst');
  });

  it('refuses a file symlink, even when it points inside the repo', () => {
    writeFileSync(join(repo, 'real.txt'), 'x\n');
    symlinkSync(join(repo, 'real.txt'), join(repo, 'link.txt'));
    expect(reasonOf('link.txt')).toContain('symlink');
  });

  it('refuses a file symlink that points outside the repo', () => {
    writeFileSync(join(outside, 'secret'), 'x\n');
    symlinkSync(join(outside, 'secret'), join(repo, 'link.txt'));
    expect(reasonOf('link.txt')).toContain('symlink');
  });

  it('refuses a path through a directory symlink that leaves the repo', () => {
    symlinkSync(outside, join(repo, 'out'));
    expect(reasonOf('out/new.txt')).toContain('symlink');
  });

  it('refuses a path through a directory symlink that reaches .karst/', () => {
    mkdirSync(join(repo, '.karst'));
    symlinkSync(join(repo, '.karst'), join(repo, 'cfg'));
    expect(reasonOf('cfg/karst.yml')).toContain('symlink');
  });

  it('refuses a dangling symlink', () => {
    symlinkSync(join(outside, 'gone'), join(repo, 'dangling'));
    expect(reasonOf('dangling')).toContain('symlink');
  });

  it('refuses when the repo directory does not exist', () => {
    expect(buildWriteFilePatch(join(root, 'nope'), 'a.txt', 'x\n')).toMatchObject({ ok: false });
  });

  it('accepts a path under a missing directory inside the repo', () => {
    expect(built('new/dir/a.txt', 'x\n').ok).toBe(true);
  });
});

describe('buildWriteFilePatch — repo directory and size', () => {
  it.each(['.git', '.karst', '.GIT'])('refuses a repo directory named %s', (name) => {
    const dir = join(root, name);
    mkdirSync(dir);
    const r = buildWriteFilePatch(dir, 'hooks/pre-commit', 'x\n');
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain('inside .git or .karst');
  });

  it('refuses a repo directory below .git', () => {
    const dir = join(root, '.git', 'hooks');
    mkdirSync(dir, { recursive: true });
    expect(buildWriteFilePatch(dir, 'pre-commit', 'x\n').ok).toBe(false);
  });

  it('refuses to replace an existing file over the size cap', () => {
    writeFileSync(join(repo, 'big.txt'), 'a'.repeat(MAX_SETUP_WRITE_CONTENT + 1));
    expect(reasonOf('big.txt', 'b\n')).toContain('larger than');
  });

  it('replaces an existing file at the size cap', () => {
    writeFileSync(join(repo, 'edge.txt'), 'a'.repeat(MAX_SETUP_WRITE_CONTENT));
    expect(built('edge.txt', 'b\n').ok).toBe(true);
  });
});
