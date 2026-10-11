import { describe, it, expect } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import type { Finding } from './findings.js';
import {
  isEmptyDiffObservation,
  reconcileRequirementFindings,
  targetHasChanges,
} from './requirements.js';

const conformance = (repo: string, requirement: string, severity = 'high'): Finding =>
  ({ severity, repo, file: null, title: `${requirement} missing`, detail: '', source: 'agent', requirement }) as Finding;

describe('reconcileRequirementFindings', () => {
  it('two voters, only one reports the gap → dropped', () => {
    expect(
      reconcileRequirementFindings(
        [
          { repo: 'api', findings: [conformance('api', 'S2')] },
          { repo: 'web', findings: [] },
        ],
        ['api', 'web'],
      ),
    ).toEqual([]);
  });
  it('kept once, forced high, attributed to the first sorted reporter', () => {
    const out = reconcileRequirementFindings(
      [
        { repo: 'api', findings: [] },
        { repo: 'web', findings: [conformance('web', 'Scenario 2', 'medium')] },
      ],
      ['web'],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('high');
    expect(out[0]!.repo).toBe('web');
  });
  it('normalizes the requirement key across case and whitespace', () => {
    const out = reconcileRequirementFindings(
      [
        { repo: 'web', findings: [conformance('web', 'Scenario 2', 'medium')] },
        { repo: 'api', findings: [conformance('api', ' scenario  2 ')] },
      ],
      ['api', 'web'],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.repo).toBe('api');
  });
  it('single voter → kept', () => {
    const a = conformance('api', 'S2');
    expect(reconcileRequirementFindings([{ repo: 'api', findings: [a] }], ['api'])).toEqual([a]);
  });
  it('a non-voter never cancels a gap another voter reported', () => {
    expect(
      reconcileRequirementFindings(
        [
          { repo: 'api', findings: [conformance('api', 'S1')] },
          { repo: 'web', findings: [] },
        ],
        ['api'],
      ),
    ).toEqual([conformance('api', 'S1')]);
  });
  it('file-anchored and non-requirement findings pass through untouched', () => {
    const fileAnchored = { ...conformance('api', 'S2'), file: 'x.ts' };
    const plain = { severity: 'low', repo: 'web', file: null, title: 't', detail: '', source: 'agent' } as Finding;
    expect(
      reconcileRequirementFindings(
        [
          { repo: 'api', findings: [fileAnchored] },
          { repo: 'web', findings: [plain] },
        ],
        ['api', 'web'],
      ),
    ).toEqual([fileAnchored, plain]);
  });
});

describe('targetHasChanges', () => {
  const git =
    (exitCode: number | 'throw'): GitRunner =>
    async () => {
      if (exitCode === 'throw') throw new Error('x');
      return { stdout: '', stderr: '', exitCode };
    };
  it('1 → true, 0 → false', async () => {
    expect(await targetHasChanges(git(1), '/w', 'a...b')).toBe(true);
    expect(await targetHasChanges(git(0), '/w', 'a...b')).toBe(false);
  });
  it('other exit, throw, no git or no range → null', async () => {
    expect(await targetHasChanges(git(128), '/w', 'a...b')).toBeNull();
    expect(await targetHasChanges(git('throw'), '/w', 'a...b')).toBeNull();
    expect(await targetHasChanges(undefined, '/w', 'a...b')).toBeNull();
    expect(await targetHasChanges(git(1), '/w', null)).toBeNull();
  });
});

describe('isEmptyDiffObservation', () => {
  it('matches the scope block observation only', () => {
    const f = (title: string, extra = {}) => ({ severity: 'info', repo: 'r', file: null, title, detail: '', source: 'agent', ...extra }) as Finding;
    expect(isEmptyDiffObservation(f('No changes to review'))).toBe(true);
    expect(isEmptyDiffObservation(f('no changes to review', { requirement: 'S1' }))).toBe(false);
    expect(isEmptyDiffObservation(f('style'))).toBe(false);
  });
});
