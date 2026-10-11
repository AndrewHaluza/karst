import { describe, it, expect } from 'vitest';
import {
  buildConformanceBlock,
  buildReviewArtifacts,
  isIntentSpecVerified,
  selectReviewArtifacts,
} from './conformance.js';

const node = (kind: 'spec' | 'plan') => ({
  kind,
  files: [{ relPath: `${kind}.md`, repo: 'r', sha: '1', text: kind.toUpperCase() }],
});

describe('selectReviewArtifacts (chain collapse)', () => {
  it('spec+plan, edge verified → intent + plan', () => {
    const a = selectReviewArtifacts({ intent: 'I', spec: node('spec'), plan: node('plan') }, true);
    expect(a.intent).toBe('I');
    expect(a.plan).toContain('PLAN');
    expect(a.spec).toBeNull();
  });
  it('spec+plan, edge NOT verified → all three', () => {
    expect(selectReviewArtifacts({ intent: 'I', spec: node('spec'), plan: node('plan') }, false).spec).toContain('SPEC');
  });
  it('intent + spec → spec is the leaf', () => {
    expect(selectReviewArtifacts({ intent: 'I', spec: node('spec'), plan: null }, true).spec).toContain('SPEC');
  });
  it('intent only', () => {
    expect(selectReviewArtifacts({ intent: 'I', spec: null, plan: null }, false)).toEqual({ intent: 'I', spec: null, plan: null });
  });
});

describe('buildConformanceBlock', () => {
  it('nothing → []', () => expect(buildConformanceBlock({ intent: null, spec: null, plan: null })).toEqual([]));
  it('states the always-high rule and impact grading', () => {
    const t = buildConformanceBlock({ intent: 'I', spec: null, plan: 'P' }).join('\n');
    expect(t).toMatch(/intent scenario .* not implemented .* ALWAYS "high"/i);
    expect(t).toMatch(/deviation from the plan/i);
    expect(t).toMatch(/work outside the plan/i);
    expect(t).toMatch(/"requirement"/);
  });
  it('no plan → does not judge out-of-plan work', () => {
    const t = buildConformanceBlock({ intent: 'I', spec: null, plan: null }).join('\n');
    expect(t).not.toMatch(/work outside the plan/i);
    expect(t).toMatch(/no plan is available/i);
  });
  it('words the outside-diff read as an absence-only exception', () => {
    const t = buildConformanceBlock({ intent: 'I', spec: null, plan: null }).join('\n');
    expect(t).toMatch(/widen beyond the diff only into a file the diff actually touches or directly calls/);
    expect(t).toMatch(/exception/i);
    expect(t).toMatch(/confirm an artifact requirement is absent/i);
  });
  it('names the other repo targets, excluding this one', () => {
    const t = buildConformanceBlock({ intent: 'I', spec: null, plan: null, targets: ['api', 'web', 'cli'] }, 'api').join('\n');
    expect(t).toMatch(/Other repository targets for this ticket: cli, web/);
    expect(t).not.toMatch(/Other repository targets for this ticket:.*\bapi\b/);
  });
  it('intent rendered before plan', () => {
    const t = buildConformanceBlock({ intent: 'INTENT', spec: null, plan: 'PLAN' }).join('\n');
    expect(t.indexOf('INTENT')).toBeLessThan(t.indexOf('PLAN'));
  });
});

describe('isIntentSpecVerified', () => {
  it('declared check → verified', () =>
    expect(isIntentSpecVerified({ checks: new Set(['intent-spec']), lastReport: null, specFp: 'a', intentFp: 'I' })).toBe(true));
  it('clean report for the current spec + intent → verified', () =>
    expect(isIntentSpecVerified({ checks: new Set(), lastReport: { specFp: 'a', intentFp: 'I', mediumPlus: 0 }, specFp: 'a', intentFp: 'I' })).toBe(true));
  it('stale spec, changed intent or dirty report → not verified', () => {
    const base = { checks: new Set<never>(), specFp: 'a', intentFp: 'I' };
    expect(isIntentSpecVerified({ ...base, lastReport: { specFp: 'old', intentFp: 'I', mediumPlus: 0 } })).toBe(false);
    expect(isIntentSpecVerified({ ...base, intentFp: 'I2', lastReport: { specFp: 'a', intentFp: 'I', mediumPlus: 0 } })).toBe(false);
    expect(isIntentSpecVerified({ ...base, lastReport: { specFp: 'a', intentFp: 'I', mediumPlus: 2 } })).toBe(false);
    expect(isIntentSpecVerified({ ...base, lastReport: null })).toBe(false);
  });
});

it('buildReviewArtifacts keeps intent and spec when no alignment report exists', () => {
  const a = buildReviewArtifacts({
    intent: 'I',
    entries: [{ repo: 'r', relPath: 's.md', sha: '1', kind: 'spec', text: 'SPECBODY' }],
    checks: new Set(),
    lastIntentSpecReport: null,
    targets: ['r'],
  });
  expect(a.intent).toBe('I');
  expect(a.spec).toContain('SPECBODY');
  expect(a.targets).toEqual(['r']);
});
