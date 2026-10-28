import { describe, expect, it } from 'vitest';
import type { GateAttemptView } from '../../model/inside/rounds.js';
import { attemptSwitcherFor } from './stateGates.js';

const attempt = (over: Partial<GateAttemptView> & { key: string }): GateAttemptView =>
  ({ label: 'R1', tail: 'of 2', status: 'fail', statusLabel: 'Failed', latest: false, ...over }) as GateAttemptView;

describe('attemptSwitcherFor attemptNote', () => {
  const attempts = [
    attempt({ key: 'a', label: 'R1' }),
    attempt({ key: 'b', label: 'R2', latest: true, caption: 'opened by gate failure · no fix attempts left' }),
  ];

  it('carries the selected round caption, e.g. the exhausted note', () => {
    const { view } = attemptSwitcherFor(attempts, 'b', false);
    expect(view?.attemptNote).toContain('no fix attempts left');
  });

  it('has no note for a historical round without a caption', () => {
    const { view } = attemptSwitcherFor(attempts, 'a', false);
    expect(view?.attemptNote).toBeUndefined();
  });

  it('yields no view for an un-looped stage', () => {
    expect(attemptSwitcherFor([attempts[0]!], undefined, false).view).toBeUndefined();
  });
});
