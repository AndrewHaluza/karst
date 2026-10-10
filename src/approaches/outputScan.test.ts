import { describe, expect, it } from 'vitest';
import { scanOutputSuggestions } from './outputScan.js';

const globs = (text: string) => scanOutputSuggestions([text]).map((s) => s.glob);

describe('scanOutputSuggestions — skill-text fixtures', () => {
  it('superpowers: plan and spec dirs with date/topic placeholders', () => {
    const text = [
      'Write the validated design (spec) to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and commit.',
      'Save plans to: `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`',
    ].join('\n');
    expect(scanOutputSuggestions([text])).toEqual([
      { glob: 'docs/superpowers/specs/**', kind: 'spec' },
      { glob: 'docs/superpowers/plans/**', kind: 'plan' },
    ]);
  });

  it('speckit: per-feature specs dir and memory dir', () => {
    const text = [
      'Create the feature directory `specs/[###-feature-name]/` and write `spec.md` there.',
      'Write the constitution to `.specify/memory/constitution.md`.',
    ].join('\n');
    expect(scanOutputSuggestions([text])).toEqual([
      { glob: 'specs/*/**', kind: 'spec' },
      { glob: '.specify/memory/**', kind: 'meta' },
    ]);
  });

  it('gsd: .planning root, research and debug subdirs', () => {
    const text = [
      'Write findings to .planning/research/ and return a summary.',
      'append it to the cross-phase defect register at `.planning/WINDOWS.md`.',
      'Create `.planning/debug/{slug}.md` for the session.',
    ].join('\n');
    expect(globs(text)).toEqual([
      '.planning/research/**',
      '.planning/**',
      '.planning/debug/**',
    ]);
    expect(scanOutputSuggestions([text])[0]?.kind).toBe('research');
  });
});

describe('scanOutputSuggestions — rules', () => {
  it('ignores paths with no write verb on the line', () => {
    expect(globs('See docs/guide/intro.md for background.')).toEqual([]);
  });

  it('ignores urls, absolute, home, parent and tooling paths', () => {
    const text = [
      'Write to https://example.com/a/b/c.md',
      'Save to /etc/out/x.md',
      'Write to ~/notes/x.md',
      'Create ../outside/x.md',
      'Write to node_modules/pkg/x.md and .git/hooks/x and .claude/skills/x.md',
    ].join('\n');
    expect(globs(text)).toEqual([]);
  });

  it('ignores a bare filename with no directory', () => {
    expect(globs('Write the result to `README.md`.')).toEqual([]);
  });

  it('dedupes across bodies and keeps first-seen order', () => {
    const a = 'Save to docs/plans/a.md';
    const b = 'Save to docs/plans/b.md\nWrite to docs/research/r.md';
    expect(scanOutputSuggestions([a, b]).map((s) => s.glob)).toEqual([
      'docs/plans/**',
      'docs/research/**',
    ]);
  });

  it('guesses kind from path words, falling back to other', () => {
    expect(scanOutputSuggestions(['Write to docs/reviews/x.md'])[0]?.kind).toBe('review');
    expect(scanOutputSuggestions(['Write to scripts/dev/x.sh'])[0]?.kind).toBe('script');
    expect(scanOutputSuggestions(['Write to out/stuff/x.md'])[0]?.kind).toBe('other');
  });

  it('caps the suggestion count', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Write to d${i}/sub/x.md`).join('\n');
    expect(scanOutputSuggestions([text])).toHaveLength(12);
  });
});
