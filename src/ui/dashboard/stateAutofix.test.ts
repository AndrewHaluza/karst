import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setAutopilotOverride, setAutopilotPaused, setAutopilotStopAfter, takeAutopilotAttempt, markConflictRound } from '../../store/autopilot.js';
import { postAgentNote } from '../../store/bulletinNotes.js';
import { readAutofix } from './stateAutofix.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';

const CONFIG: AutopilotConfig = {
  enabled: true,
  ci: { policy: 'auto', maxAttempts: 3, checks: ['lint'] },
  conflicts: { policy: 'auto', maxRounds: 2 },
};

function setup() {
  const store = openStore(':memory:');
  const t = createTicket(store, { key: 'T-1', title: 't', source: 'manual' });
  return { store, id: t.id };
}

describe('readAutofix', () => {
  it('reports the project default and an inherit override', () => {
    const { store, id } = setup();
    const r = readAutofix(store, id, CONFIG);
    expect(r.slice).toMatchObject({ override: 'inherit', projectDefault: true, effective: true, banner: null, log: [] });
    expect(r.row).toBeNull();
  });

  it('treats an absent manifest block as off', () => {
    const { store, id } = setup();
    expect(readAutofix(store, id, undefined).slice).toMatchObject({ projectDefault: false, effective: false });
  });

  it('follows the ticket override over the project default', () => {
    const { store, id } = setup();
    setAutopilotOverride(store, id, 'off');
    expect(readAutofix(store, id, CONFIG).slice).toMatchObject({ override: 'off', projectDefault: true, effective: false });
  });

  it('reads a paused reason as the Merge row and a banner', () => {
    const { store, id } = setup();
    setAutopilotPaused(store, id, 'auto-fix paused: sandbox is read-only');
    const r = readAutofix(store, id, CONFIG);
    expect(r.row).toMatchObject({ state: 'paused', message: 'Auto-fix paused: sandbox is read-only' });
    expect(r.slice.banner).toMatchObject({ state: 'paused', primary: { act: 'autopilot-retry' } });
  });

  it('reads an armed conflict round as running with the budget counter', () => {
    const { store, id } = setup();
    takeAutopilotAttempt(store, id, 'web', 'conflicts', 'base1', 2);
    markConflictRound(store, id, Date.now());
    const r = readAutofix(store, id, CONFIG);
    expect(r.row).toMatchObject({ state: 'running', message: expect.stringContaining('round 1 of 2') });
  });

  it('keeps the stop-after request on a running round', () => {
    const { store, id } = setup();
    takeAutopilotAttempt(store, id, 'web', 'conflicts', 'base1', 2);
    markConflictRound(store, id, Date.now());
    setAutopilotStopAfter(store, id);
    expect(readAutofix(store, id, CONFIG).row?.stopAfterRequested).toBe(true);
  });

  it('lists the last autopilot notes of the ticket, newest first, and no other note', () => {
    const { store, id } = setup();
    postAgentNote(store, { projectId: null, fromTicketId: id, title: 'Autopilot: first', body: 'a' });
    postAgentNote(store, { projectId: null, fromTicketId: id, title: 'Unrelated', body: 'b' });
    postAgentNote(store, { projectId: null, fromTicketId: id, title: 'Autopilot: second', body: 'c' });
    expect(readAutofix(store, id, CONFIG).slice.log).toEqual(['Autopilot: second', 'Autopilot: first']);
  });
});
