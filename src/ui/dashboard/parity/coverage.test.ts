import { describe, it, expect } from 'vitest';
import { COVERED, NOT_COVERED } from './parityCases.js';
import { actsInSource } from './actsInSource.js';

const CASES_FILE = 'src/ui/dashboard/parity/actions.render.integration.test.ts';

describe('dashboard parity — coverage guard', () => {
  const sourceActs = actsInSource();
  const covered = new Set(COVERED.map((c) => c.act));

  it('reads a plausible act list from the source', () => {
    expect(sourceActs.length).toBeGreaterThan(55);
    expect(sourceActs).toContain('merge-pr');
    expect(sourceActs).toContain('stop-server');
  });

  it.each(sourceActs)('act %s has a parity case or an explicit NOT_COVERED reason', (a) => {
    expect(
      covered.has(a) || a in NOT_COVERED,
      `no parity case for data-act="${a}" — add a case to COVERED in src/ui/dashboard/parity/parityCases.ts (exercised by ${CASES_FILE}) or a NOT_COVERED reason (≥10 chars)`,
    ).toBe(true);
  });

  it('NOT_COVERED holds only real acts, each with a reason, never also covered', () => {
    for (const [a, why] of Object.entries(NOT_COVERED)) {
      expect(sourceActs, `stale NOT_COVERED entry ${a}`).toContain(a);
      expect(why.length).toBeGreaterThan(10);
      expect(covered.has(a), `${a} is both covered and NOT_COVERED`).toBe(false);
    }
  });

  it('every case names an act the source still has', () => {
    for (const c of COVERED) expect(sourceActs, `case for unknown act ${c.act}`).toContain(c.act);
  });
});
