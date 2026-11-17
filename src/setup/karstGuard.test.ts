import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { karstWriteViolation, patchTargets, restoreKarstFiles, snapshotKarstFiles } from './karstGuard.js';

let root: string;
let repo: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'karst-guard-')));
  repo = join(root, 'web');
  mkdirSync(join(root, '.karst'), { recursive: true });
  mkdirSync(join(repo, '.karst'), { recursive: true });
  writeFileSync(join(root, '.karst', 'karst.yml'), 'host: a\n');
  writeFileSync(join(repo, 'a.txt'), 'x\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const patch = (lines: string[]): string => `${lines.join('\n')}\n`;
const edit = (path: string): string =>
  patch([`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-host: a', '+host: b']);

describe('patchTargets', () => {
  it('reads the ---/+++, rename and copy headers and skips /dev/null', () => {
    const text = patch([
      '--- /dev/null', '+++ b/new.txt', 'rename from old.txt', 'rename to moved.txt', 'copy to copied.txt',
      '--- "a/quoted.txt"\t2020-01-01',
    ]);
    expect(patchTargets(text).sort()).toEqual(['b/new.txt', 'a/quoted.txt', 'copied.txt', 'moved.txt', 'old.txt'].sort());
  });
});

describe('karstWriteViolation', () => {
  it('refuses a patch on .karst/karst.yml of the workspace root', () => {
    expect(karstWriteViolation(edit('.karst/karst.yml'), root, [root])).toMatch(/\.karst\/karst\.yml/);
  });
  it('refuses .KARST/karst.yml', () => {
    expect(karstWriteViolation(edit('.KARST/karst.yml'), root, [root])).toBeDefined();
  });
  it('refuses a .karst path of a repo, from the repo directory', () => {
    expect(karstWriteViolation(edit('.karst/karst.yml'), repo, [root, repo])).toBeDefined();
  });
  it('refuses a target reached through a symlink', () => {
    symlinkSync(join(root, '.karst'), join(repo, 'link'));
    expect(karstWriteViolation(edit('link/karst.yml'), repo, [root, repo])).toBeDefined();
  });
  it('refuses a rename to a .karst path', () => {
    const text = patch(['diff --git a/a.txt b/.karst/karst.yml', 'rename from a.txt', 'rename to .karst/karst.yml']);
    expect(karstWriteViolation(text, repo, [root, repo])).toBeDefined();
  });
  it('refuses a copy to a .karst path', () => {
    const text = patch(['diff --git a/a.txt b/.karst/x', 'copy from a.txt', 'copy to .karst/x']);
    expect(karstWriteViolation(text, repo, [root, repo])).toBeDefined();
  });
  it('allows an ordinary file', () => {
    expect(karstWriteViolation(edit('a.txt'), repo, [root, repo])).toBeUndefined();
  });
});

describe('snapshot and restore', () => {
  it('reports no change when the file is untouched', () => {
    const snap = snapshotKarstFiles([root]);
    expect(restoreKarstFiles(snap)).toEqual([]);
  });
  it('restores the bytes of a changed file and names it', () => {
    const file = join(root, '.karst', 'karst.yml');
    const snap = snapshotKarstFiles([root]);
    writeFileSync(file, 'host: evil\n');
    expect(restoreKarstFiles(snap)).toEqual(['.karst/karst.yml']);
    expect(readFileSync(file, 'utf8')).toBe('host: a\n');
  });
  it('removes a file that did not exist before', () => {
    const file = join(repo, '.karst', 'karst.yml');
    const snap = snapshotKarstFiles([repo]);
    writeFileSync(file, 'new');
    expect(restoreKarstFiles(snap)).toEqual(['.karst/karst.yml']);
    expect(existsSync(file)).toBe(false);
  });
});
