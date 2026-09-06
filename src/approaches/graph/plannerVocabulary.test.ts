import { describe, expect, it } from 'vitest';
import type { CompileContext } from './compile.js';
import { plannerVocabulary, plannerVocabularyFor } from './driver.js';

function context(): CompileContext {
  return {
    profiles: new Map([['worker', 'worker']]),
    commands: new Map(),
    repositories: new Map(),
    artifactFileExists: () => true,
    expertSpend: { spentPlannerRuns: 1, permittedReplans: 0, bootstrapUnspent: false },
    projectMaxima: { maxNodeRuns: 4, maxExpertRuns: 1, maxReplans: 0 },
  };
}

const ROOT = '/global/graph/proj/421/9/artifacts';

describe('plannerVocabulary — the artifact root', () => {
  it('states the run\'s absolute artifact root', () => {
    expect(plannerVocabulary(context(), ROOT)).toContain(ROOT);
  });

  it('warns against the doubled `artifacts/` prefix the root name invites', () => {
    // The root directory is itself named `artifacts`, so a declared
    // `artifacts/plan/PLAN.md` resolves to `.../artifacts/artifacts/plan/PLAN.md`
    // and compiles to `planner-artifact-missing`.
    const block = plannerVocabulary(context(), ROOT);
    expect(block).toContain('artifacts/');
    expect(block).toMatch(/do not prefix|never prefix/i);
  });

  it('omits the artifact-root line when no root is known', () => {
    expect(plannerVocabulary(context(), '')).not.toContain('artifact root');
  });

  it('degrades to no block when the compile context throws', () => {
    expect(
      plannerVocabularyFor(() => {
        throw new Error('unbound project');
      }, ROOT),
    ).toBe('');
  });
});
