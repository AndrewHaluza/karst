import { describe, it, expect } from 'vitest';
import { markerStageFor, MARKER_STAGES } from './markerStage.js';
import { STAGE_GRAPH } from '../workflow/graph.js';

describe('MARKER_STAGES', () => {
  it('is exactly the pair an agent may mark', () => {
    expect(MARKER_STAGES).toEqual(['impl', 'fix']);
  });

  it('covers every value markerStageFor can return', () => {
    const produced = new Set(
      (['scope', 'impl', 'uat', 'review', 'fix', 'ship', 'done', null] as const).map(markerStageFor),
    );
    expect([...produced].sort()).toEqual([...MARKER_STAGES].sort());
  });

  // The CLI narrows to these keys so an agent can't self-report a gate. That only
  // holds while no marker stage has a `failed` edge — the moment one does, a
  // `fail` verdict becomes reachable and the dropped fail branch must come back.
  it('has no marker stage with a failed edge', () => {
    for (const stage of MARKER_STAGES) {
      expect(STAGE_GRAPH[stage].failed).toBeUndefined();
    }
  });
});

describe('markerStageFor', () => {
  it('seeds the fix marker to a session resumed at fix', () => {
    expect(markerStageFor('fix')).toBe('fix');
  });

  it('seeds the impl marker for interactive impl work', () => {
    expect(markerStageFor('impl')).toBe('impl');
  });

  it('falls back to impl for every non-interactive stage', () => {
    // Only impl and fix have an interactive continuation (resumeDecision); a seed
    // written at any other stage is a fresh impl launch.
    for (const stage of ['scope', 'uat', 'review', 'ship', 'done'] as const) {
      expect(markerStageFor(stage)).toBe('impl');
    }
    expect(markerStageFor(null)).toBe('impl');
  });
});
