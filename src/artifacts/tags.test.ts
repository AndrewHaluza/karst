import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Store } from '../store/db.js';
import { completeImplementationRun, openImplementationRun } from '../store/implementationRuns.js';
import { recordPhaseMark } from '../store/phaseMarks.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { transition } from '../workflow/machine.js';
import { resolveTrailers } from './tags.js';

const out = { approachId: 'gsd', kind: 'plan' };

describe('resolveTrailers', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' });
  });
  afterEach(() => store.close());

  const openRun = () =>
    openImplementationRun(store, { ticketId, attempt: 0, provider: 'claude', startedAt: '2026-08-01T10:00:00.000Z' });

  it('tags manual-edit when no run is active', () => {
    expect(resolveTrailers(store, ticketId, out)).toEqual({ approach: 'gsd', kind: 'plan', source: 'manual-edit' });
  });

  it('tags session, stage and latest phase while a run is running', () => {
    const run = openRun();
    recordPhaseMark(store, { ticketId, stageKey: 'impl', attempt: 0, phaseName: 'research', markedAt: 'a' });
    recordPhaseMark(store, { ticketId, stageKey: 'impl', attempt: 0, phaseName: 'plan', markedAt: 'b' });
    expect(resolveTrailers(store, ticketId, out)).toEqual({
      approach: 'gsd', kind: 'plan', source: 'watcher', session: String(run.id), stage: 'impl', phase: 'plan',
    });
  });

  it('reverts to manual-edit once the run has ended', () => {
    openRun();
    completeImplementationRun(store, ticketId, '2026-08-01T11:00:00.000Z');
    expect(resolveTrailers(store, ticketId, out).source).toBe('manual-edit');
  });
});
