/**
 * Change-set capture and claim-validation tests (Slice 3 Task 8).
 *
 * `git diff --name-status` output is PARSED output in the same spirit as the
 * merge-probe lesson (`mergeCheck.test.ts` carries VERBATIM git fixtures):
 * rename lines carry a second field, and a naive split invents paths. Claim
 * validation matches exact files OR directory subtrees on separator
 * boundaries — `abc` never covers `abc-2`.
 */

import { describe, it, expect } from 'vitest';
import {
  parseNameStatus,
  validateChangeSet,
  isPathWithinClaim,
  MAX_CHANGE_SET_PATHS,
} from './changeSet.js';
import type { GitRunner } from '../../../integrations/git.js';

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
