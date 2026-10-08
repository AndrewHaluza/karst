import { describe, it, expect } from 'vitest';
import { agentCliReady, buildGettingStartedState, TUTORIAL_STEPS } from './state.js';
import type { SetupItem } from '../../init/status.js';

const checklist: SetupItem[] = [
  { id: 'manifest', label: 'm', done: false, detail: null },
  { id: 'git', label: 'g', done: true, detail: null },
  { id: 'agent-cli', label: 'a', done: true, detail: 'note', enables: 'sessions' },
];

describe('buildGettingStartedState', () => {
  it('carries the checklist through unchanged', () => {
    expect(buildGettingStartedState(checklist).checklist).toEqual(checklist);
  });

  it('attaches the tutorial steps, gating the setup action on the agent CLI', () => {
    const tutorial = buildGettingStartedState(checklist).tutorial;
    expect(tutorial).toHaveLength(TUTORIAL_STEPS.length);
    const setup = tutorial.find((s) => s.action === 'setup-agent')!;
    expect(setup.enabled).toBe(true);
    // Every other field comes straight from the fixed step.
    expect({ ...setup, enabled: undefined }).toEqual(
      TUTORIAL_STEPS.find((s) => s.action === 'setup-agent')!,
    );
  });

  it('has five tutorial steps with unique ids', () => {
    expect(TUTORIAL_STEPS).toHaveLength(5);
    expect(new Set(TUTORIAL_STEPS.map((s) => s.id)).size).toBe(5);
  });

  it('only uses known action values', () => {
    for (const s of TUTORIAL_STEPS) {
      expect(['settings', 'create-ticket', 'setup-agent', null]).toContain(s.action);
    }
  });
});

describe('agentCliReady', () => {
  it('is true only when every session-enabling item is done', () => {
    expect(agentCliReady([{ id: 'a', label: 'a', done: true, detail: null, enables: 'sessions' }])).toBe(true);
    expect(
      agentCliReady([
        { id: 'a', label: 'a', done: true, detail: null, enables: 'sessions' },
        { id: 'b', label: 'b', done: false, detail: null, enables: 'sessions' },
      ]),
    ).toBe(false);
  });

  it('is false when there is no session-enabling item', () => {
    expect(agentCliReady([{ id: 'm', label: 'm', done: true, detail: null }])).toBe(false);
  });

  it('disables the setup action when the agent CLI is missing', () => {
    const missing: SetupItem[] = [{ id: 'agent-cli', label: 'a', done: false, detail: null, enables: 'sessions' }];
    const tutorial = buildGettingStartedState(missing).tutorial;
    expect(tutorial.find((s) => s.action === 'setup-agent')!.enabled).toBe(false);
  });
});
