import { describe, it, expect } from 'vitest';
import { buildWelcomeState, TUTORIAL_STEPS } from './state.js';
import type { SetupItem } from '../../init/status.js';

const checklist: SetupItem[] = [
  { id: 'manifest', label: 'm', done: false, detail: null },
  { id: 'git', label: 'g', done: true, detail: null },
  { id: 'agent-cli', label: 'a', done: true, detail: 'note' },
];

describe('buildWelcomeState', () => {
  it('carries the checklist through unchanged', () => {
    expect(buildWelcomeState(checklist).checklist).toEqual(checklist);
  });

  it('attaches the fixed tutorial steps', () => {
    expect(buildWelcomeState(checklist).tutorial).toEqual(TUTORIAL_STEPS);
  });

  it('has five tutorial steps with unique ids', () => {
    expect(TUTORIAL_STEPS).toHaveLength(5);
    expect(new Set(TUTORIAL_STEPS.map((s) => s.id)).size).toBe(5);
  });

  it('only uses known action values', () => {
    for (const s of TUTORIAL_STEPS) {
      expect(['settings', 'create-ticket', null]).toContain(s.action);
    }
  });
});
