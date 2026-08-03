import { describe, it, expect } from 'vitest';
import { REVIEW_GATES, UAT_GATES } from './scripts.js';

describe('REVIEW_GATES', () => {
  it('names the package.json script each gate depends on', () => {
    // The script name is what makes a gate answerable: `npm run lint` in a repo
    // with no lint script exits 1, which is a fact about the repo's config, not
    // about the ticket's code.
    expect(REVIEW_GATES.map((g) => [g.name, g.script])).toEqual([
      ['lint', 'lint'],
      ['typecheck', 'typecheck'],
      ['build', 'build'],
      ['format', 'format:check'],
    ]);
  });

  // `npm run format` conventionally rewrites files in place (prettier --write,
  // gofmt -w, …), and ship's `git add -A` would commit that rewrite as if the
  // ticket authored it. `format:check` is also the only variant of the two
  // that can meaningfully FAIL — a rewriting gate almost always exits 0.
  it('runs the check variant of format, not the writer', () => {
    const formatGate = REVIEW_GATES.find((g) => g.name === 'format');
    expect(formatGate).toEqual({
      name: 'format',
      script: 'format:check',
      args: ['run', 'format:check'],
    });
  });

  // `test` used to be here too, which meant every review run duplicated UAT's
  // own gate list (`UAT_GATES` below) on the same worktree — the exact
  // condition `requireIndependentSignal` (R7, `review/aggregate.ts`) exists to
  // catch. Removing it here closes the duplication at the source rather than
  // only failing tickets downstream once R7 lands.
  it('does not duplicate UAT_GATES\' test gate', () => {
    expect(REVIEW_GATES.map((g) => g.name)).not.toContain('test');
  });
});

describe('UAT_GATES', () => {
  it('is a non-empty list whose first entry is the repo test script', () => {
    expect(UAT_GATES.length).toBeGreaterThan(0);
    expect(UAT_GATES[0]).toEqual({ name: 'test', script: 'test', args: ['test'] });
  });
});
