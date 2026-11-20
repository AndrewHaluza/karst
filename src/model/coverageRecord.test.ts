import { describe, it, expect } from 'vitest';
import {
  COVERAGE_PREFIX,
  COVERAGE_RULE_UAT,
  COVERAGE_RULE_REVIEW,
  coverageStatus,
  isCoverageRecord,
  splitCoverage,
  stripCoverageLabel,
  coverageOrFallback,
  coverageCriterion,
  criteriaSummary,
  coverageAllOrFallback,
} from './coverageRecord.js';

const rec = (title: string, severity = 'info') => ({ severity, title });

describe('coverageRecord', () => {
  it('recognises a record by its title prefix, whatever severity the agent gave', () => {
    expect(isCoverageRecord(rec(`${COVERAGE_PREFIX}PASS — checked x`))).toBe(true);
    expect(isCoverageRecord(rec(`${COVERAGE_PREFIX}PASS — x`, 'high'))).toBe(true);
    expect(isCoverageRecord(rec('Coverage of the picker is poor'))).toBe(false);
  });

  it('derives PASS / SKIPPED / NOT RUN, defaulting to NOT RUN when unstated', () => {
    expect(coverageStatus(`${COVERAGE_PREFIX}PASS — a`)).toBe('PASS');
    expect(coverageStatus(`${COVERAGE_PREFIX}SKIPPED — picker DOM: not reachable`)).toBe('SKIPPED');
    expect(coverageStatus(`${COVERAGE_PREFIX}NOT RUN — x`)).toBe('NOT RUN');
    expect(coverageStatus(`${COVERAGE_PREFIX}looked fine`)).toBe('NOT RUN');
  });

  it('splits records from real findings', () => {
    const c = rec(`${COVERAGE_PREFIX}PASS — a`);
    const f = rec('real bug', 'high');
    expect(splitCoverage([f, c])).toEqual({ coverage: [c], rest: [f] });
  });

  it('keeps only the first record, forced to info; falls back to NOT RUN when silent', () => {
    const a = rec(`${COVERAGE_PREFIX}PASS — a`, 'high');
    const b = rec(`${COVERAGE_PREFIX}SKIPPED — b`);
    expect(coverageOrFallback([a, b])).toEqual({ ...a, severity: 'info' });
    const fb = coverageOrFallback<{ severity: string; title: string }>([]);
    expect(fb.severity).toBe('info');
    expect(fb.title.startsWith(`${COVERAGE_PREFIX}NOT RUN`)).toBe(true);
  });

  it('prompt rules describe the record, "reported" and never "verified"', () => {
    for (const r of [COVERAGE_RULE_UAT, COVERAGE_RULE_REVIEW]) {
      expect(r).toContain(COVERAGE_PREFIX);
      expect(r).toContain('PASS');
      expect(r).toContain('SKIPPED');
      expect(r).not.toMatch(/verified/i);
    }
    expect(COVERAGE_RULE_UAT).toContain('uat:host');
  });
});

describe('stripCoverageLabel', () => {
  it('strips a leading label so the record reads as coverage, not a fallback', () => {
    const labelled = rec('COGNITIVE: COVERAGE (reported): SKIPPED — not reachable', 'low');
    const { coverage, rest } = splitCoverage(stripCoverageLabel([labelled]));
    expect(rest).toEqual([]);
    expect(coverage).toHaveLength(1);
    expect(coverageStatus(coverage[0]!.title)).toBe('SKIPPED');
    expect(coverageOrFallback(coverage).title).toBe('COVERAGE (reported): SKIPPED — not reachable');
  });

  it('keeps a real finding that mentions the prefix later in its title', () => {
    const f = rec('Bug: see COVERAGE (reported): PASS claim', 'high');
    const out = stripCoverageLabel([f]);
    expect(out).toEqual([f]);
    expect(splitCoverage(out).rest).toEqual([f]);
  });

  it('leaves an unlabelled record and a lowercase or long label alone', () => {
    for (const t of ['COVERAGE (reported): PASS — x', 'note: COVERAGE (reported): PASS', `${'A'.repeat(30)}: COVERAGE (reported): PASS`]) {
      expect(stripCoverageLabel([rec(t)])).toEqual([rec(t)]);
    }
  });
});

describe('criterion records', () => {
  const t = (rest: string) => `${COVERAGE_PREFIX}${rest}`;
  it('parses the C<n> tag after the status', () => {
    expect(coverageCriterion(t('PASS [C3] picker opens — ran x'))).toBe('C3');
    expect(coverageCriterion(t('FAIL [C12] x — y'))).toBe('C12');
    expect(coverageStatus(t('FAIL [C1] x'))).toBe('FAIL');
    expect(coverageCriterion(t('PASS — legacy'))).toBeNull();
    expect(coverageCriterion('nit [C1]')).toBeNull();
  });
  it('summarises tested and untested criteria; null for legacy', () => {
    expect(criteriaSummary([t('PASS [C1] a — x'), t('SKIPPED [C2] b — y'), t('NOT RUN [C5] c — z'), t('FAIL [C3] d — w')])).toBe(
      '2 of 4 criteria tested; not tested: C2, C5',
    );
    expect(criteriaSummary([t('PASS [C1] a — x')])).toBe('1 of 1 criteria tested');
    expect(criteriaSummary([t('PASS — legacy')])).toBeNull();
  });
  it('keeps all records up to the cap, else the fallback', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ severity: 'high', title: t(`PASS [C${i}] x`) }));
    expect(coverageAllOrFallback(many)).toHaveLength(20);
    expect(coverageAllOrFallback(many)[0]!.severity).toBe('info');
    expect(coverageAllOrFallback<{ severity: string; title: string }>([])[0]!.title).toContain('NOT RUN');
  });
  it('the UAT rule asks for a record for each criterion; the review rule does not', () => {
    expect(COVERAGE_RULE_UAT).toContain('[C<n>]');
    expect(COVERAGE_RULE_REVIEW).not.toContain('[C<n>]');
  });
});
