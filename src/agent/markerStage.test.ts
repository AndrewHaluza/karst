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
    // Every non-null answer is a real marker stage — a seed can only carry a
    // marker the CLI will actually accept.
    for (const value of produced) {
      if (value !== null) expect(MARKER_STAGES).toContain(value);
    }
    expect(produced.has('impl')).toBe(true);
    expect(produced.has('fix')).toBe(true);
    expect(produced.has(null)).toBe(true);
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

  it.each(['uat', 'review', 'ship', 'done'] as const)(
    'returns null for %s (a gate stage, no marker to fire)',
    (stage) => {
      expect(markerStageFor(stage)).toBeNull();
    },
  );

  it('returns null at every stage that has no marker to fire (869edna84)', () => {
    // Only impl and fix have an interactive continuation (resumeDecision). A
    // seed written at any other stage would name an earlier stage's marker,
    // which the CLI refuses — an agent that trusted it would report the ticket
    // advanced when it had not moved, so the seed must carry no marker at all.
    for (const stage of ['scope', 'uat', 'review', 'ship', 'done'] as const) {
      expect(markerStageFor(stage)).toBeNull();
    }
    expect(markerStageFor(null)).toBeNull();
  });
});
