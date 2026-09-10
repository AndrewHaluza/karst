import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/**
 * The checked-in mode counts from `docs/ui/VISUAL-COVERAGE.md`.
 * These must match the output of the grep commands documented there.
 * If a rule is added or reclassified, these numbers must be updated.
 */
const CHECKED_IN_COUNTS = {
  total: 44,
  static: 33,
  runtime: 18,
  visual: 15,
  review: 7,
};

/**
 * The one VISUAL rule still enforced only by F5.  Never grows.
 */
const STILL_MANUAL = new Set(['UI-R22']);

test.describe('VISUAL rule coverage ratchet', () => {
  test('UI-RULES.md mode counts match VISUAL-COVERAGE.md', () => {
    const rules = readFileSync(join(ROOT, 'docs', 'ui', 'UI-RULES.md'), 'utf8');

    // Count total rules.
    const totalRules = (rules.match(/^## UI-R/gm) || []).length;
    expect(totalRules).toBe(CHECKED_IN_COUNTS.total);

    // Count verification lines by mode.
    const verificationLines = (rules.match(/\*\*Verification:\*\*.*/g) || []);
    expect(verificationLines.length).toBe(CHECKED_IN_COUNTS.total);

    let staticCount = 0;
    let runtimeCount = 0;
    let visualCount = 0;
    let reviewCount = 0;

    for (const line of verificationLines) {
      if (line.includes('STATIC')) staticCount++;
      if (line.includes('RUNTIME')) runtimeCount++;
      if (line.includes('VISUAL')) visualCount++;
      if (line.includes('REVIEW')) reviewCount++;
    }

    expect(staticCount).toBe(CHECKED_IN_COUNTS.static);
    expect(runtimeCount).toBe(CHECKED_IN_COUNTS.runtime);
    expect(visualCount).toBe(CHECKED_IN_COUNTS.visual);
    expect(reviewCount).toBe(CHECKED_IN_COUNTS.review);
  });

  test('every VISUAL rule has a row in the coverage table', () => {
    const coverage = readFileSync(
      join(ROOT, 'docs', 'ui', 'VISUAL-COVERAGE.md'),
      'utf8',
    );

    // Extract VISUAL rule ids from UI-RULES.md.
    const rules = readFileSync(join(ROOT, 'docs', 'ui', 'UI-RULES.md'), 'utf8');
    const verificationLines = (rules.match(/\*\*Verification:\*\*.*/g) || []);
    const ruleIds: string[] = [];
    const ruleHeaders = (rules.match(/^## (UI-R\d+\w?)\s/gm) || []);
    for (const header of ruleHeaders) {
      const id = header.replace(/^## /, '').trim();
      ruleIds.push(id);
    }

    // Find which rules have VISUAL in their verification.
    const visualRules: string[] = [];
    let i = 0;
    for (const line of verificationLines) {
      if (line.includes('VISUAL') && ruleIds[i]) {
        visualRules.push(ruleIds[i]!);
      }
      i++;
    }

    // Assert every VISUAL rule has a row in the coverage table.
    for (const id of visualRules) {
      expect(
        coverage,
        `VISUAL-COVERAGE.md missing row for ${id}`,
      ).toContain(id);
    }
  });

  test('the "still manual" set is exactly {UI-R22} and never grows', () => {
    const coverage = readFileSync(
      join(ROOT, 'docs', 'ui', 'VISUAL-COVERAGE.md'),
      'utf8',
    );

    // Find the "Still manual" line.
    const manualMatch = coverage.match(/Still manual after this ticket:(.+)/);
    expect(manualMatch).not.toBeNull();

    // Extract rule ids from the "Still manual" line.
    const manualText = manualMatch![1]!;
    const manualIds = new Set(
      (manualText.match(/UI-R\d+\w?/g) || []).map((id) => id),
    );

    // Assert it's exactly {UI-R22}.
    expect(manualIds).toEqual(STILL_MANUAL);

    // Assert the set never grows — it must be a subset of STILL_MANUAL.
    for (const id of manualIds) {
      expect(STILL_MANUAL.has(id)).toBe(true);
    }
  });
});
