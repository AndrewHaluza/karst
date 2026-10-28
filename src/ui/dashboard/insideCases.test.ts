import { describe, expect, it } from 'vitest';
import { INSIDE_CASES } from './insideCases.js';

const ids = (stage: string) => INSIDE_CASES.filter((c) => c.stage === stage).map((c) => c.id);

const INSIDE_STAGE_KEYS = ['scope', 'impl', 'uat', 'review', 'ship', 'done'] as const;

describe('inside case registry (ui:VISUAL-VARIANTS)', () => {
  it('gives every stage pending, running and passed cases', () => {
    for (const stage of INSIDE_STAGE_KEYS) {
      for (const id of ['pending', 'running', 'passed']) expect(ids(stage), `${stage} lacks ${id}`).toContain(id);
    }
  });

  it('has unique stage/id pairs', () => {
    const keys = INSIDE_CASES.map((c) => `${c.stage}-${c.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(['uat', 'review'] as const)('%s has looped cases with 2+ attempts and a selected attempt', (stage) => {
    for (const id of ['fix-running', 'passed-round-2', 'older-round', 'exhausted']) {
      const c = INSIDE_CASES.find((x) => x.stage === stage && x.id === id);
      expect(c, `${stage}-${id}`).toBeDefined();
      const view = c!.state().insideViews[stage];
      expect(view.attempts?.length ?? 0, `${stage}-${id} attempts`).toBeGreaterThanOrEqual(2);
      expect(view.selectedAttempt, `${stage}-${id} selected`).toBeTruthy();
    }
  });

  it('older-round selects a non-latest attempt', () => {
    for (const stage of ['uat', 'review'] as const) {
      const v = INSIDE_CASES.find((x) => x.stage === stage && x.id === 'older-round')!.state().insideViews[stage];
      expect(v.attempts!.find((a) => a.key === v.selectedAttempt)?.latest).toBeFalsy();
    }
  });
});
