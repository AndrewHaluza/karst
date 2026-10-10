import { describe, expect, it } from 'vitest';
import { ManifestError } from '../manifest/error.js';
import { manifest } from '../manifest/fixtures.js';
import { effectiveOutputs } from './outputs.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pendingOutputViews, pendingOutputsByApproach, withAcceptedOutputs } from './pendingOutputs.js';
import { writeApproachArtifacts } from './pkg.js';

describe('pendingOutputViews', () => {
  it('lists non-empty suggestions with the built-in defaults as pre-accepted', () => {
    const views = pendingOutputViews({
      superpowers: [{ glob: 'docs/x/**', kind: 'other' }],
      custom: [{ glob: 'out/**', kind: 'other' }],
      empty: [],
    });
    expect(views).toEqual({
      superpowers: {
        suggestions: [{ glob: 'docs/x/**', kind: 'other' }],
        preAccepted: [
          { glob: 'docs/superpowers/plans/**', kind: 'plan' },
          { glob: 'docs/superpowers/specs/**', kind: 'spec' },
        ],
      },
      custom: { suggestions: [{ glob: 'out/**', kind: 'other' }], preAccepted: [] },
    });
  });
});

describe('withAcceptedOutputs', () => {
  const accepted = [{ glob: 'out/**', kind: 'meta' as const }];

  it('appends to a project approach that already declares outputs, deduping by glob', () => {
    const m = manifest({}, {
      approaches: [{ id: 'mine', label: 'M', outputs: [{ glob: 'out/**', kind: 'plan' }, { glob: 'a/**', kind: 'plan' }] }],
    });
    const next = withAcceptedOutputs(m, 'mine', [...accepted, { glob: 'b/**', kind: 'spec' }]);
    expect(next.approaches?.[0]?.outputs).toEqual([
      { glob: 'out/**', kind: 'plan' },
      { glob: 'a/**', kind: 'plan' },
      { glob: 'b/**', kind: 'spec' },
    ]);
    expect(m.approaches?.[0]?.outputs).toHaveLength(2); // input untouched
  });

  it('keeps the default-table outputs when accepting onto an approach with none declared', () => {
    const m = manifest({}, { approaches: [{ id: 'gsd', label: 'G' }] });
    const next = withAcceptedOutputs(m, 'gsd', accepted);
    expect(effectiveOutputs(next).map((o) => o.glob)).toEqual(['.planning/**', 'out/**']);
  });

  it('starts from an empty list when the approach has no declared outputs or defaults', () => {
    const m = manifest({}, { approaches: [{ id: 'mine', label: 'M' }] });
    expect(withAcceptedOutputs(m, 'mine', accepted).approaches?.[0]?.outputs).toEqual(accepted);
  });

  it('validates the accepted entries', () => {
    const m = manifest({}, { approaches: [{ id: 'mine', label: 'M' }] });
    expect(() => withAcceptedOutputs(m, 'mine', [{ glob: '../x/**', kind: 'plan' }])).toThrow(ManifestError);
  });

  it('is a no-op copy when nothing is accepted', () => {
    const m = manifest({}, { approaches: [{ id: 'mine', label: 'M' }] });
    expect(withAcceptedOutputs(m, 'mine', [])).toEqual(m);
  });

  it('throws for an approach the manifest does not know', () => {
    expect(() => withAcceptedOutputs(manifest({}, { approaches: [] }), 'ghost', accepted)).toThrow(ManifestError);
  });
});

describe('pendingOutputsByApproach', () => {
  it('lists only installed packages that have pending suggestions', () => {
    const base = mkdtempSync(join(tmpdir(), 'karst-pending-'));
    try {
      const pending = [{ glob: 'docs/x/**', kind: 'plan' as const }];
      writeApproachArtifacts(base, { id: 'a', label: 'A', prompts: [], pendingOutputs: pending }, []);
      writeApproachArtifacts(base, { id: 'b', label: 'B', prompts: [] }, []);
      expect(pendingOutputsByApproach(() => base)).toEqual({ a: pending });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('degrades to nothing when the directory cannot be resolved', () => {
    expect(pendingOutputsByApproach(() => { throw new Error('no workspace'); })).toEqual({});
  });
});
