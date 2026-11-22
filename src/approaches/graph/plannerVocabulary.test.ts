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
    spentNodeRuns: 0,
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

  it('states the node runs already spent in the run', () => {
    const block = plannerVocabulary({ ...context(), spentNodeRuns: 3 }, ROOT);
    expect(block).toContain('3 node runs already spent in this graph run; maxNodeRuns counts them');
    expect(plannerVocabulary(context(), ROOT)).not.toContain('node runs already spent');
  });

  it('omits the replans line when the project permits no replans and none are spent', () => {
    expect(plannerVocabulary(context(), ROOT)).not.toContain('- replans:');
  });

  it('states the replan headroom when replans remain (spentReplans 0)', () => {
    const block = plannerVocabulary(
      { ...context(), projectMaxima: { maxNodeRuns: 4, maxExpertRuns: 6, maxReplans: 3 } },
      ROOT,
    );
    expect(block).toContain(
      '- replans: 0 replans already spent in this graph run, the project maximum is 3;',
    );
    expect(block).toContain('counts the replans of the whole run, so declare it above');
    expect(block).toContain('0 and not above 3. The project `budgets.maxExpertRuns` cap is 6.');
    expect(block).not.toContain('no automatic replans remain');
  });

  it('counts every planner run but the bootstrap one as a spent replan', () => {
    const block = plannerVocabulary(
      {
        ...context(),
        expertSpend: { spentPlannerRuns: 3, permittedReplans: 1, bootstrapUnspent: false },
        projectMaxima: { maxNodeRuns: 4, maxExpertRuns: 6, maxReplans: 3 },
      },
      ROOT,
    );
    expect(block).toContain('- replans: 2 replans already spent in this graph run, the project maximum is 3;');
    const unspent = plannerVocabulary(
      {
        ...context(),
        expertSpend: { spentPlannerRuns: 2, permittedReplans: 1, bootstrapUnspent: true },
        projectMaxima: { maxNodeRuns: 4, maxExpertRuns: 6, maxReplans: 3 },
      },
      ROOT,
    );
    expect(unspent).toContain('- replans: 2 replans already spent');
  });

  it('says no automatic replans remain once the spent replans reach the project maximum', () => {
    const block = plannerVocabulary(
      {
        ...context(),
        expertSpend: { spentPlannerRuns: 3, permittedReplans: 0, bootstrapUnspent: false },
        projectMaxima: { maxNodeRuns: 4, maxExpertRuns: 6, maxReplans: 2 },
      },
      ROOT,
    );
    expect(block).toContain('- replans: 2 replans already spent in this graph run, the project maximum is 2;');
    expect(block).toContain('no automatic replans remain. Declare `budgets.maxReplans` equal to the project');
    expect(block).toContain('maximum 2: a value above it fails to compile.');
    expect(block).not.toContain('declare it above');
  });

  it('shows the replans line when replans are spent but the project maximum is 0', () => {
    const block = plannerVocabulary(
      { ...context(), expertSpend: { spentPlannerRuns: 2, permittedReplans: 0, bootstrapUnspent: false } },
      ROOT,
    );
    expect(block).toContain('- replans: 1 replans already spent in this graph run, the project maximum is 0;');
    expect(block).toContain('no automatic replans remain');
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
