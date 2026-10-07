import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTrackedFiles, findAbsoluteHostPaths } from './agentsTree.js';

describe('findAbsoluteHostPaths', () => {
  it('catches a macOS home path', () => {
    expect(findAbsoluteHostPaths('node "/Users/nd/dist/cli/main.js" guide'))
      .toEqual(['/Users/nd/dist/cli/main.js']);
  });

  it('catches a Linux home path', () => {
    expect(findAbsoluteHostPaths('--db /home/ci/.local/karst.db'))
      .toEqual(['/home/ci/.local/karst.db']);
  });

  it('catches a Windows drive-letter path', () => {
    expect(findAbsoluteHostPaths('node C:\\Users\\nd\\main.js'))
      .toEqual(['C:\\Users\\nd\\main.js']);
  });

  it('deduplicates a path repeated across lines', () => {
    const text = '/Users/nd/a.js\nand again /Users/nd/a.js\n';
    expect(findAbsoluteHostPaths(text)).toEqual(['/Users/nd/a.js']);
  });

  it('does not flag a repo-relative path a document legitimately names', () => {
    const text = 'see src/agent/workflowCommand.ts and .agents/skills/x/SKILL.md';
    expect(findAbsoluteHostPaths(text)).toEqual([]);
  });

  it('does not flag an absolute path that is not a host root', () => {
    // `/usr/bin/env` and `/tmp` are the same on every machine; the guard is
    // about paths that identify ONE developer's laptop.
    expect(findAbsoluteHostPaths('#!/usr/bin/env node')).toEqual([]);
  });
});

describe('listTrackedFiles', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agents-tree-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    // A bare `git commit` in CI/sandboxes can fail without configured
    // identity; set one locally to this throwaway repo only.
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'tracked.md'), 'tracked');
    writeFileSync(join(root, 'sub', 'untracked.md'), 'untracked');
    execFileSync('git', ['add', join('sub', 'tracked.md')], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns only the tracked file under the subdir, not the untracked one', () => {
    expect(listTrackedFiles(root, 'sub')).toEqual([join(root, 'sub', 'tracked.md')]);
  });

  it('returns an empty list for a subdir with no tracked files (empty ls-files output, not a throw)', () => {
    expect(listTrackedFiles(root, 'nope')).toEqual([]);
  });

  it('returns an empty list rather than throwing when repoRoot is not a git checkout', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'agents-tree-non-repo-'));
    try {
      expect(listTrackedFiles(nonRepo, 'sub')).toEqual([]);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
