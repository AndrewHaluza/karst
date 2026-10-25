import { describe, it, expect } from 'vitest';
import {
  COVERAGE_PREFIX,
  COVERAGE_RULE_UAT,
  COVERAGE_RULE_REVIEW,
  coverageStatus,
  isCoverageRecord,
  splitCoverage,
  coverageOrFallback,
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
