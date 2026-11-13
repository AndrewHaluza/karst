import { describe, expect, it } from 'vitest';
import { WEBVIEW_NAMES } from '../../src/model/webviewChains.js';
import { SWEEP_BUDGET, sweepCounts } from './sweepBudget.js';

describe('sweep budget ratchet (@ui:SWEEP-BUDGET)', () => {
  it('has a budget for every webview', () => {
    expect(Object.keys(SWEEP_BUDGET).sort()).toEqual([...WEBVIEW_NAMES].sort());
  });

  it('keeps each view at its budget: a raise needs a reason in sweepBudget.ts, a drop lowers the number', () => {
    const counts = sweepCounts();
    const moved = WEBVIEW_NAMES.flatMap((view) =>
      (['screenshots', 'layout'] as const)
        .filter((kind) => counts[view][kind] !== SWEEP_BUDGET[view][kind])
        .map((kind) => {
          const now = counts[view][kind];
          const budget = SWEEP_BUDGET[view][kind];
          return now > budget
            ? `${view}.${kind}: ${now} > budget ${budget} (+${now - budget}). Share a layout run or drop a theme, or raise the budget with a reason.`
            : `${view}.${kind}: ${now} < budget ${budget}. Lower the budget to ${now}.`;
        }),
    );
    expect(moved).toEqual([]);
  });
});
