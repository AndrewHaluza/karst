import { describe, expect, it } from 'vitest';
import { manifest, repo } from '../../manifest/fixtures.js';
import { regenerateOption } from './regenerateOption.js';

const withRegen = (commands: string[]) =>
  manifest({ extention: repo({ repoPath: '/w/karst', ship: { regenerate: commands, exclude: ['x/**'] } }) });

describe('regenerateOption', () => {
  it('finds the manifest entry through target.names when target.repo is a repo path (the T880 bug)', () => {
    const r = regenerateOption(withRegen(['gen']), { repo: '/w/karst', names: ['extention'] });
    expect(r).toEqual({ regenerate: { repo: 'extention', commands: ['gen'], exclude: ['x/**'] } });
  });

  it('falls back to repo as a manifest key when no names are given', () => {
    expect(regenerateOption(withRegen(['gen']), { repo: 'extention', names: [] }).regenerate?.repo).toBe('extention');
  });

  it.each([
    ['no manifest', undefined, { repo: '/w', names: [] }, 'no manifest passed'],
    ['name mismatch', withRegen(['gen']), { repo: '/w', names: ['other'] }, 'no manifest repository matches other'],
    ['empty list', withRegen([]), { repo: '/w', names: ['extention'] }, 'ship.regenerate is empty or undeclared'],
  ])('%s → {} and a skip debug line', (_n, m, target, reason) => {
    const lines: string[] = [];
    expect(regenerateOption(m, target, (l) => lines.push(l))).toEqual({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[gate] regenerate (');
    expect(lines[0]).toContain(`skipped — ${reason}`);
  });
});
