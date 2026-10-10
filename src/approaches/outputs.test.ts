import { describe, expect, it } from 'vitest';
import { ManifestError } from '../manifest/error.js';
import { manifest } from '../manifest/fixtures.js';
import type { ApproachDef } from '../manifest/types.js';
import { DEFAULT_OUTPUTS, effectiveOutputs, validateOutputs } from './outputs.js';

const def = (id: string, extra: Partial<ApproachDef> = {}): ApproachDef => ({ id, label: id, ...extra });
const withApproaches = (approaches: ApproachDef[]) => manifest({}, { approaches });

describe('validateOutputs', () => {
  it('accepts well-formed entries and returns copies', () => {
    const raw = [{ glob: 'docs/plans/**', kind: 'plan' }, { glob: '**/*.md', kind: 'other' }];
    const out = validateOutputs(raw, 'o');
    expect(out).toEqual(raw);
    expect(out[0]).not.toBe(raw[0]);
  });

  it('accepts brace groups and dotted names that are not traversal', () => {
    const raw = [{ glob: 'docs/{plans,specs}/**', kind: 'plan' }, { glob: 'a..b/**', kind: 'other' }];
    expect(validateOutputs(raw, 'o')).toEqual(raw);
  });

  it('accepts an empty list', () => {
    expect(validateOutputs([], 'o')).toEqual([]);
  });

  it.each([
    ['not an array', 'x', /o must be an array/],
    ['entry not an object', ['x'], /o\[0\] must be an object/],
    ['missing glob', [{ kind: 'plan' }], /o\[0\]\.glob/],
    ['empty glob', [{ glob: '', kind: 'plan' }], /o\[0\]\.glob/],
    ['bad kind', [{ glob: 'a/**', kind: 'nope' }], /o\[0\]\.kind must be one of plan\|research/],
    ['missing kind', [{ glob: 'a/**' }], /o\[0\]\.kind/],
    ['absolute', [{ glob: '/a/**', kind: 'plan' }], /o\[0\]\.glob/],
    ['dotdot', [{ glob: 'a/../b/**', kind: 'plan' }], /o\[0\]\.glob/],
    ['dotdot after glob', [{ glob: 'a/**/../b', kind: 'plan' }], /o\[0\]\.glob/],
    ['empty segment', [{ glob: 'a//b/**', kind: 'plan' }], /o\[0\]\.glob/],
    ['trailing slash', [{ glob: 'a/', kind: 'plan' }], /o\[0\]\.glob/],
    ['dot segment', [{ glob: './a/**', kind: 'plan' }], /o\[0\]\.glob/],
    ['drive alias', [{ glob: 'C:/a/**', kind: 'plan' }], /o\[0\]\.glob/],
    ['backslash', [{ glob: 'a\\b/**', kind: 'plan' }], /o\[0\]\.glob/],
    ['reserved device in prefix', [{ glob: 'docs/con/**', kind: 'plan' }], /o\[0\]\.glob/],
    ['dotdot in brace group', [{ glob: '{a,..}/x', kind: 'plan' }], /o\[0\]\.glob/],
    ['dotdot in brace group tail', [{ glob: 'docs/{x,../y}', kind: 'plan' }], /o\[0\]\.glob/],
    ['slash inside brace group', [{ glob: '{a/b,c}/x', kind: 'plan' }], /o\[0\]\.glob/],
    ['tilde segment', [{ glob: '~/x', kind: 'plan' }], /o\[0\]\.glob/],
    ['unknown key', [{ glob: 'a/**', kind: 'plan', extra: 1 }], /o\[0\]\.extra/],
  ])('rejects %s', (_n, raw, msg) => {
    expect(() => validateOutputs(raw, 'o')).toThrow(ManifestError);
    expect(() => validateOutputs(raw, 'o')).toThrow(msg);
  });
});

describe('effectiveOutputs', () => {
  it('uses built-in defaults when an approach declares none, tagged by id', () => {
    const out = effectiveOutputs(withApproaches([def('gsd')]));
    expect(out).toEqual([{ approachId: 'gsd', glob: '.planning/**', kind: 'plan' }]);
  });

  it('declared outputs replace defaults entirely', () => {
    const out = effectiveOutputs(
      withApproaches([def('gsd', { outputs: [{ glob: 'notes/**', kind: 'research' }] })]),
    );
    expect(out).toEqual([{ approachId: 'gsd', glob: 'notes/**', kind: 'research' }]);
  });

  it('an empty declared list falls back to defaults', () => {
    const out = effectiveOutputs(withApproaches([def('gsd', { outputs: [] })]));
    expect(out).toHaveLength(1);
  });

  it('unknown approach without outputs contributes nothing', () => {
    expect(effectiveOutputs(withApproaches([def('mystery')]))).toEqual([]);
  });

  it('unions across approaches in manifest order', () => {
    const out = effectiveOutputs(
      withApproaches([def('speckit'), def('custom', { outputs: [{ glob: 'x/**', kind: 'script' }] }), def('gsd')]),
    );
    expect(out.map((o) => [o.approachId, o.glob])).toEqual([
      ['speckit', 'specs/**'],
      ['speckit', '.specify/memory/**'],
      ['custom', 'x/**'],
      ['gsd', '.planning/**'],
    ]);
  });

  it('skips disabled approaches', () => {
    expect(effectiveOutputs(withApproaches([def('gsd', { enabled: false })]))).toEqual([]);
  });

  it('returns [] when the manifest has no approaches', () => {
    expect(effectiveOutputs(manifest({}, {}))).toEqual([]);
  });

  it('does not alias the defaults table', () => {
    const out = effectiveOutputs(withApproaches([def('gsd')]));
    expect(out[0]).not.toBe(DEFAULT_OUTPUTS['gsd']![0]);
  });
});

describe('DEFAULT_OUTPUTS', () => {
  it('pins the verified table', () => {
    expect(DEFAULT_OUTPUTS).toEqual({
      superpowers: [
        { glob: 'docs/superpowers/plans/**', kind: 'plan' },
        { glob: 'docs/superpowers/specs/**', kind: 'spec' },
      ],
      speckit: [
        { glob: 'specs/**', kind: 'spec' },
        { glob: '.specify/memory/**', kind: 'meta' },
      ],
      gsd: [{ glob: '.planning/**', kind: 'plan' }],
      rpi: [
        { glob: 'rpi/*/research/**', kind: 'research' },
        { glob: 'rpi/*/plan/**', kind: 'plan' },
      ],
    });
  });

  it('every default passes validation', () => {
    for (const list of Object.values(DEFAULT_OUTPUTS)) {
      expect(() => validateOutputs(list, 'd')).not.toThrow();
    }
  });
});
