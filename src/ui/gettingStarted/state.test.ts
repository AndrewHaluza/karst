import { describe, it, expect } from 'vitest';
import { agentCliReady, buildGettingStartedState, TUTORIAL_STEPS } from './state.js';
import { buildAgentSetupView } from '../../setup/checklist/panelView.js';
import type { SetupItem } from '../../init/status.js';

const checklist: SetupItem[] = [
  { id: 'manifest', label: 'm', done: false, detail: null },
  { id: 'git', label: 'g', done: true, detail: null },
  { id: 'agent-cli', label: 'a', done: true, detail: 'note', enables: 'sessions' },
];

const allDone: SetupItem[] = [
  { id: 'manifest', label: 'm', done: true, detail: null },
  { id: 'git', label: 'g', done: true, detail: null },
  { id: 'agent-cli', label: 'a', done: true, detail: 'note', enables: 'sessions' },
];

const manifestMissing: SetupItem[] = [
  { id: 'manifest', label: 'm', done: false, detail: null },
  { id: 'agent-cli', label: 'a', done: true, detail: 'note', enables: 'sessions' },
];

const agentMissing: SetupItem[] = [
  { id: 'manifest', label: 'm', done: true, detail: null },
  { id: 'agent-cli', label: 'a', done: false, detail: null, enables: 'sessions' },
];

const NO_TICKETS = { ticketCount: 0 } as const;
const TICKETS = { ticketCount: 16 } as const;

describe('buildGettingStartedState', () => {
  it('carries the agent setup view when given and omits the key when not', () => {
    const view = buildAgentSetupView({ items: undefined, error: null, checking: true, updatedLabel: null });
    expect(buildGettingStartedState(checklist, NO_TICKETS, view).agentSetup).toBe(view);
    expect('agentSetup' in buildGettingStartedState(checklist, NO_TICKETS)).toBe(false);
  });

  it('carries the checklist through unchanged', () => {
    expect(buildGettingStartedState(checklist, NO_TICKETS).checklist).toEqual(checklist);
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

  // GS-5: the manifest actions live in the manifest row alone, so no tutorial
  // step offers a second "Set up with agent" button.
  it('keeps the setup-agent button out of the tutorial', () => {
    for (const s of TUTORIAL_STEPS) expect(s.action, s.id).not.toBe('setup-agent');
  });
});

describe('progressText', () => {
  it('states how many checklist items are done', () => {
    expect(buildGettingStartedState([], NO_TICKETS).progressText).toBe('0 of 0 done');
    expect(buildGettingStartedState([checklist[0]!], NO_TICKETS).progressText).toBe('0 of 1 done');
    expect(buildGettingStartedState([allDone[0]!], NO_TICKETS).progressText).toBe('1 of 1 done');
    expect(buildGettingStartedState(checklist, NO_TICKETS).progressText).toBe('2 of 3 done');
    expect(buildGettingStartedState(allDone, NO_TICKETS).progressText).toBe('3 of 3 done');
  });
});

describe('lede', () => {
  it('asks the user to finish while an item is open', () => {
    expect(buildGettingStartedState(manifestMissing, NO_TICKETS).lede).toBe('Finish the setup below.');
    // Tickets do not hide an unfinished setup.
    expect(buildGettingStartedState(manifestMissing, TICKETS).lede).toBe('Finish the setup below.');
  });

  it('points a complete setup with no ticket at the ticket form', () => {
    expect(buildGettingStartedState(allDone, NO_TICKETS).lede).toBe('Setup is complete. Create a ticket to start.');
  });

  it('says only that setup is complete when tickets exist', () => {
    expect(buildGettingStartedState(allDone, TICKETS).lede).toBe('Setup is complete.');
  });
});

describe('manifestActions', () => {
  it('makes Set up with agent primary when the agent CLI is ready', () => {
    expect(buildGettingStartedState(allDone, NO_TICKETS).manifestActions).toEqual({
      primary: 'setup-agent',
      secondary: 'create-manifest',
    });
  });

  it('makes the starter file primary and Set up with agent secondary when the CLI is missing', () => {
    expect(buildGettingStartedState(agentMissing, NO_TICKETS).manifestActions).toEqual({
      primary: 'create-manifest',
      secondary: 'setup-agent',
    });
  });
});

describe('tutorial progress marks', () => {
  const step = (state: ReturnType<typeof buildGettingStartedState>, id: string) =>
    state.tutorial.find((s) => s.id === id)!;

  it('marks configure done when the manifest item is done', () => {
    expect(step(buildGettingStartedState(allDone, NO_TICKETS), 'configure').done).toBe(true);
    expect(step(buildGettingStartedState(manifestMissing, NO_TICKETS), 'configure').done).toBe(false);
  });

  it('points step 1 at the manifest row instead of offering its own button', () => {
    const configure = step(buildGettingStartedState(allDone, NO_TICKETS), 'configure');
    expect(configure.action).toBeNull();
    expect(configure.description).toBe('Use the manifest row in the setup checklist above.');
  });

  it('keeps the first-ticket step open when no ticket exists', () => {
    const create = step(buildGettingStartedState(allDone, NO_TICKETS), 'create');
    expect(create.label).toBe('Create your first ticket');
    expect(create.done).toBe(false);
  });

  it('marks the ticket step done with its returning label when tickets exist', () => {
    const create = step(buildGettingStartedState(allDone, TICKETS), 'create');
    expect(create.label).toBe('Create a ticket');
    expect(create.description).toBe('Describe the work. Karst fetches or drafts the context brief.');
    expect(create.done).toBe(true);
    expect(create.action).toBe('create-ticket');
  });
});

describe('tutorial copy (GS-10)', () => {
  it('words steps 3 and 4', () => {
    const tutorial = buildGettingStartedState(allDone, NO_TICKETS).tutorial;
    expect(tutorial[2]!.description).toBe('Choose the repositories and the approach, then start the session');
    expect(tutorial[3]!.description).toBe('Follow the ticket through its stages on the ticket dashboard.');
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
});
