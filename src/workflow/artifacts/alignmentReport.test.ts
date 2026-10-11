import { describe, it, expect } from 'vitest';
import { alignmentReportPath, readLastAlignmentReport } from './alignmentReport.js';

const store = (trailers?: Record<string, string>) => ({
  history: async () => (trailers ? [{ sha: 't', at: '', trailers }, { sha: 's', at: '', trailers: { specfp: 'old', intentfp: 'old', mediumplus: '9' } }] : []),
});

describe('readLastAlignmentReport', () => {
  it('reads the newest revision, round-tripping mediumPlus 0', async () => {
    expect(await readLastAlignmentReport(store({ specfp: 'S', intentfp: 'I', mediumplus: '0' }), 1, 'intent-spec')).toEqual({
      specFp: 'S',
      intentFp: 'I',
      mediumPlus: 0,
    });
  });
  it('no history or incomplete trailers → null', async () => {
    expect(await readLastAlignmentReport(store(), 1, 'intent-spec')).toBeNull();
    expect(await readLastAlignmentReport(store({ kind: 'review' }), 1, 'intent-spec')).toBeNull();
    expect(await readLastAlignmentReport(store({ specfp: 'S', intentfp: 'I', mediumplus: 'NaN' }), 1, 'intent-spec')).toBeNull();
  });
  it('path under the _karst pseudo-repo', () => {
    expect(alignmentReportPath('intent-spec')).toBe('_karst/alignment/intent-spec.md');
  });
});
