import { describe, it, expect } from 'vitest';
import { markerStageFor } from './markerStage.js';

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
