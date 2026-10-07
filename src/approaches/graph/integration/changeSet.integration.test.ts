/**
 * Change-set capture and claim-validation tests (Slice 3 Task 8).
 *
 * `git diff --name-status` output is PARSED output in the same spirit as the
 * merge-probe lesson (`mergeCheck.test.ts` carries VERBATIM git fixtures):
 * rename lines carry a second field, and a naive split invents paths. Claim
 * validation matches exact files OR directory subtrees on separator
 * boundaries — `abc` never covers `abc-2`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseNameStatus,
  validateChangeSet,
  isPathWithinClaim,
  captureUntrackedPaths,
  MAX_CHANGE_SET_PATHS,
} from './changeSet.js';
import type { GitRunner } from '../../../integrations/git.js';

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-cs-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@karst']);
  git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.ts'), 'a\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

const runner: GitRunner = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return Promise.resolve({ stdout: r.stdout.trim(), stderr: r.stderr, exitCode: r.status ?? -1 });
};

const cleanups: (() => void)[] = [];
beforeEach(() => (cleanups.length = 0));
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('parseNameStatus', () => {
  it('parses verbatim `git diff --name-status` output', () => {
    const stdout = [
      'M\tsrc/a.ts',
      'A\tsrc/new.ts',
      'D\tsrc/gone.ts',
      'R100\tsrc/old.ts\tsrc/renamed.ts',
      'M\tsrc/with\ttab.ts',
      '',
    ].join('\n');
    expect(parseNameStatus(stdout)).toEqual([
      { path: 'src/a.ts', kind: 'modified' },
      { path: 'src/new.ts', kind: 'added' },
      { path: 'src/gone.ts', kind: 'deleted' },
      { path: 'src/renamed.ts', kind: 'renamed' },
      { path: 'src/with\ttab.ts', kind: 'modified' },
    ]);
  });

  it('maps copy and unmerged codes onto the closed kinds', () => {
    expect(parseNameStatus('C50\ta\tb\nU\tc\nT\td\n').map((e) => e.kind)).toEqual([
      'renamed',
      'modified',
      'modified',
    ]);
  });

  it('ignores blank lines and git chatter lines', () => {
    expect(parseNameStatus('\n\nM\ta.ts\n')).toEqual([{ path: 'a.ts', kind: 'modified' }]);
  });

  it('bounded: never returns more than the path cap', () => {
    const lines = Array.from({ length: MAX_CHANGE_SET_PATHS + 25 }, (_, i) => `A\tf${i}.ts`);
    const entries = parseNameStatus(lines.join('\n'));
    expect(entries.length).toBeLessThanOrEqual(MAX_CHANGE_SET_PATHS);
  });
});

describe('isPathWithinClaim', () => {
  it('matches an exact file and directory-subtree descendants, never a sibling prefix', () => {
    expect(isPathWithinClaim('src/a.ts', 'src/a.ts')).toBe(true);
    expect(isPathWithinClaim('src/components/Button.tsx', 'src/components')).toBe(true);
    expect(isPathWithinClaim('src/components', 'src/components')).toBe(true);
    expect(isPathWithinClaim('src/a.tsx', 'src/a.ts')).toBe(false);
    expect(isPathWithinClaim('src/abc-2/file.ts', 'src/abc')).toBe(false);
    expect(isPathWithinClaim('other/a.ts', 'src/a.ts')).toBe(false);
  });
});

describe('captureUntrackedPaths', () => {
  it('lists new files `git diff --name-status` never sees, honoring ignore rules', async () => {
    const dir = makeRepo();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'new.ts'), 'n\n');
    writeFileSync(join(dir, 'ignored.log'), 'x\n');
    writeFileSync(join(dir, '.gitignore'), '*.log\n');
    expect(await captureUntrackedPaths(runner, dir)).toEqual(['.gitignore', 'new.ts']);
  });

  it('an out-of-claim untracked file must flow into the SAME claim validation as a tracked one', async () => {
    // Regression for the defect the dynamic-graph e2e test names: untracked
    // paths were enumerated only to decide what to COPY into the canonical
    // worktree, never fed into `validateChangeSet` — so an agent-created file
    // outside its declared claim was silently dropped, not reported as a
    // violation. `captureDomainChangeSet` (pipeline.ts) now merges untracked
    // paths into the captured entries as `added`; this pins that an untracked
    // path is treated exactly like a tracked one by validation.
    const dir = makeRepo();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'OUTSIDE.ts'), 'outside\n');
    const untracked = await captureUntrackedPaths(runner, dir);
    const entries = untracked.map((path) => ({ path, kind: 'added' as const }));
    const result = validateChangeSet(['src'], entries);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations).toEqual(['OUTSIDE.ts']);
  });
});

describe('validateChangeSet', () => {
  it('passes a change set fully inside the declared writes', () => {
    const result = validateChangeSet(
      ['src', 'README.md'],
      [
        { path: 'src/a.ts', kind: 'modified' },
        { path: 'src/deep/b.ts', kind: 'added' },
        { path: 'README.md', kind: 'modified' },
      ],
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an out-of-claim file, naming each violation', () => {
    const result = validateChangeSet(
      ['src/a.ts'],
      [
        { path: 'src/a.ts', kind: 'modified' },
        { path: 'src/b.ts', kind: 'added' },
        { path: 'package.json', kind: 'deleted' },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toEqual(['src/b.ts', 'package.json']);
    }
  });

  it('bounded: never reports more violations than the cap', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ path: `x${i}.ts`, kind: 'modified' as const }));
    const result = validateChangeSet(['y.ts'], entries);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.length).toBeLessThanOrEqual(20);
    }
  });

  it('an empty declared set accepts nothing', () => {
    const result = validateChangeSet([], [{ path: 'a.ts', kind: 'modified' }]);
    expect(result.ok).toBe(false);
  });
});
