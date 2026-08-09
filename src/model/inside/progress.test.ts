import { describe, it, expect } from 'vitest';
import {
  shipStartedEvent,
  shipFinishedEvent,
  shipClearedEvent,
  validateInsideProgressEvent,
} from './progress.js';
import { shipProcesses } from './ship.js';

/**
 * The ship lifecycle as ONE generic inside-progress 'ship' process (Finding
 * 12): the whole invocation speaks the same union as gates and Fix — `active`
 * while it runs, one complete process row when it settles, `cleared` when the
 * following authoritative snapshot supersedes the overlay. These helpers are
 * what the workflow boundary emits; the panel boundary re-validates the result,
 * so every event below must survive `validateInsideProgressEvent`.
 */
/**
 * The ids the ship snapshot's process roster actually carries — derived from
 * the real reducer, never hardcoded, so the overlay's completed row can always
 * replace a row the snapshot contains instead of appending a phantom one.
 */
const SHIP_PROCESS_IDS = shipProcesses({
  cell: { stageKey: 'ship', status: 'pending' },
  evidence: { run: undefined, repos: {} },
  prs: [],
  mergeChecks: [],
  now: '2026-08-09T00:00:00.000Z',
}).map((p) => p.id);

describe('ship lifecycle events (Finding 12)', () => {
  it('starts with a host-formatted live operation, not raw repo/step structures', () => {
    const event = shipStartedEvent(7);
    expect(event).toEqual({
      kind: 'active',
      ticketId: 7,
      stage: 'ship',
      processId: 'ship',
      live: { status: 'run', label: 'Shipping' },
    });
    expect(validateInsideProgressEvent(event)).toEqual(event);
  });

  it('emits a completed event whose id exists in the ship snapshot', () => {
    const ev = shipFinishedEvent(7, 'pass');
    if (ev.kind !== 'completed') throw new Error('shipFinishedEvent must emit a completed event');
    expect(SHIP_PROCESS_IDS).toContain(ev.process.id);
  });

  it('finishes with a complete process row that passes the wire validator', () => {
    const event = shipFinishedEvent(7, 'pass');
    expect(event).toEqual({
      kind: 'completed',
      ticketId: 7,
      stage: 'ship',
      process: { id: 'pr', kind: 'ship', label: 'Ship', status: 'pass' },
    });
    expect(validateInsideProgressEvent(event)).toEqual(event);
  });

  it('finishes failed with the same complete row shape', () => {
    const event = shipFinishedEvent(7, 'fail');
    expect(event).toMatchObject({
      kind: 'completed',
      stage: 'ship',
      process: { id: 'pr', kind: 'ship', label: 'Ship', status: 'fail' },
    });
    expect(validateInsideProgressEvent(event)).toEqual(event);
  });

  it('clears with no invented result when a snapshot supersedes the overlay', () => {
    const event = shipClearedEvent(7);
    expect(event).toEqual({ kind: 'cleared', ticketId: 7, stage: 'ship', processId: 'ship' });
    expect(validateInsideProgressEvent(event)).toEqual(event);
  });

  it('refuses to finish with any status the live/terminal vocabularies reject', () => {
    expect(validateInsideProgressEvent(shipFinishedEvent(7, 'pass'))).not.toBeNull();
    expect(validateInsideProgressEvent(shipFinishedEvent(7, 'fail'))).not.toBeNull();
  });
});
