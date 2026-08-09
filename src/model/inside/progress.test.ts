import { describe, it, expect } from 'vitest';
import {
  shipStartedEvent,
  shipFinishedEvent,
  shipClearedEvent,
  shipStepEvent,
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

describe('shipStepEvent (the live header names the step)', () => {
  it('names the running describe step as the PR operation on its repo', () => {
    const event = shipStepEvent(7, { repo: 'api', step: 'describe', status: 'run' });
    expect(event).toEqual({
      kind: 'active',
      ticketId: 7,
      stage: 'ship',
      processId: 'ship',
      live: { status: 'run', label: 'PR · api', detail: 'updating description' },
    });
    expect(validateInsideProgressEvent(event!)).toEqual(event);
  });

  it('produces nothing for a passed step — the next run event replaces the header', () => {
    expect(shipStepEvent(7, { repo: 'api', step: 'describe', status: 'pass' })).toBeNull();
  });

  it('produces nothing for a note step — work not (re-)run is not an operation in flight', () => {
    expect(shipStepEvent(7, { repo: 'api', step: 'describe', status: 'note' })).toBeNull();
  });

  it('names a failed step as failed, with the step detail', () => {
    const event = shipStepEvent(7, { repo: 'api', step: 'describe', status: 'fail' });
    expect(event).not.toBeNull();
    if (event?.kind !== 'active') return;
    expect(event.live.status).toBe('fail');
    expect(event.live.label).toBe('PR · api');
    expect(event.live.detail).toBe('updating description failed');
  });

  it('caps untrusted detail at 200 chars so the event survives the wire validator', () => {
    // `event.detail` can carry CLI or model prose; without the cap the whole
    // event would be dropped at the wire boundary (>240 chars).
    const event = shipStepEvent(7, {
      repo: 'api',
      step: 'pr',
      status: 'run',
      detail: 'x'.repeat(5000),
    });
    expect(event).not.toBeNull();
    if (event?.kind !== 'active') return;
    expect(event.live.detail).toHaveLength(200);
    expect(validateInsideProgressEvent(event)).toEqual(event);
  });
});
