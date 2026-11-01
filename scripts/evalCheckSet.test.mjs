import { describe, expect, it } from 'vitest';
import {
  NOOP_PATCH,
  buildConfig,
  classifyReport,
  harnessId,
  isDrifted,
  parseArgs,
  patchLine,
  summarize,
} from './evalCheckSet.mjs';

const row = { org: 'vuejs', repo: 'core', number: 11813, fix_patch: 'diff --git a/x b/x\n' };

describe('evalCheckSet', () => {
  it('builds the harness id like the upstream report', () => {
    expect(harnessId(row)).toBe('vuejs/core:pr-11813');
  });

  it('uses the upstream gold patch, or the no-op for the control', () => {
    expect(patchLine(row, 'gold').fix_patch).toBe(row.fix_patch);
    expect(patchLine(row, 'control').fix_patch).toBe(NOOP_PATCH);
    expect(patchLine(row, 'gold')).toMatchObject({ org: 'vuejs', repo: 'core', number: 11813 });
  });

  it('roots every config path in the run dir and runs one worker', () => {
    const c = buildConfig('/t/d');
    expect(c.workdir).toBe('/t/d/work');
    expect(c.patch_files).toEqual(['/t/d/patch.jsonl']);
    expect(c.dataset_files).toEqual(['/t/d/dataset.jsonl']);
    expect(c.max_workers).toBe(1);
  });

  it('classifies a harness report', () => {
    const id = harnessId(row);
    expect(classifyReport({ resolved_ids: [id], unresolved_ids: [] }, id)).toBe('resolved');
    expect(classifyReport({ resolved_ids: [], unresolved_ids: [id] }, id)).toBe('unresolved');
    expect(classifyReport({ resolved_ids: [], unresolved_ids: [] }, id)).toBe('error');
    expect(classifyReport(undefined, id)).toBe('error');
  });

  it('flags gold drift unless every run resolved', () => {
    expect(isDrifted(['resolved', 'resolved', 'resolved'], 'gold')).toBe(false);
    expect(isDrifted(['resolved', 'unresolved', 'resolved'], 'gold')).toBe(true);
    expect(isDrifted(['resolved', 'error'], 'gold')).toBe(true);
    expect(isDrifted([], 'gold')).toBe(true);
  });

  it('flags a control that resolves or errors', () => {
    expect(isDrifted(['unresolved', 'unresolved'], 'control')).toBe(false);
    expect(isDrifted(['resolved'], 'control')).toBe(true);
    expect(isDrifted(['error'], 'control')).toBe(true);
  });

  it('summarizes drifted ids', () => {
    const s = summarize(
      [
        { id: 'a', outcomes: ['resolved'] },
        { id: 'b', outcomes: ['unresolved'] },
      ],
      'gold',
    );
    expect(s).toEqual({ kind: 'gold', total: 2, drifted: ['b'], passing: 1 });
  });

  it('parses and validates args', () => {
    expect(parseArgs([]).runs).toBe(1);
    const o = parseArgs(['--runs', '3', '--only', 'a,b', '--control', '--keep-images', '--set', 's.jsonl']);
    expect(o).toMatchObject({ runs: 3, only: ['a', 'b'], control: true, keepImages: true, set: 's.jsonl' });
    expect(() => parseArgs(['--runs', '0'])).toThrow('positive integer');
    expect(() => parseArgs(['--runs'])).toThrow('needs a value');
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument');
  });
});
