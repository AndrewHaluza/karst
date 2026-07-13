import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import type { Stage } from '../store/stages.js';
import type { StageKey } from '../model/types.js';

function stageOf(store: Store, ticketId: number, key: StageKey): Stage {
  const s = getTicket(store, ticketId).stages.find((x) => x.stageKey === key);
  if (!s) throw new Error(`no stage ${key}`);
  return s;
}

describe('transition (stage machine core)', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  it('pass at scope advances to impl and sets stage_current', () => {
    const next = transition(store, ticketId, 'scope', { kind: 'passed' });
    expect(next).toBe('impl');
    expect(getTicket(store, ticketId).stageCurrent).toBe('impl');
    expect(stageOf(store, ticketId, 'scope').status).toBe('passed');
    expect(stageOf(store, ticketId, 'impl').status).toBe('running');
  });

  it('pass at uat advances to review', () => {
    expect(transition(store, ticketId, 'uat', { kind: 'passed' })).toBe('review');
  });

  it('fail at uat routes to fix and increments the failing stage attempt', () => {
    const before = stageOf(store, ticketId, 'uat').attempt;
    const next = transition(store, ticketId, 'uat', { kind: 'failed', reason: 'x' });
    expect(next).toBe('fix');
    expect(stageOf(store, ticketId, 'uat').status).toBe('failed');
    expect(stageOf(store, ticketId, 'uat').attempt).toBe(before + 1);
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
  });

  it('fail persists the reason as the stage verdict', () => {
    transition(store, ticketId, 'review', { kind: 'failed', reason: 'lint broke' });
    expect(stageOf(store, ticketId, 'review').verdict).toBe('lint broke');
  });

  it('fix pass re-enters review (revalidate loop)', () => {
    expect(transition(store, ticketId, 'fix', { kind: 'passed' })).toBe('review');
  });

  it('fail at review routes to fix', () => {
    expect(transition(store, ticketId, 'review', { kind: 'failed' })).toBe('fix');
  });

  it('pass at review advances to ship, ship to done', () => {
    expect(transition(store, ticketId, 'review', { kind: 'passed' })).toBe('ship');
    expect(transition(store, ticketId, 'ship', { kind: 'passed' })).toBe('done');
  });

  it('a null verdict does NOT transition (no-inference guarantee)', () => {
    expect(() => transition(store, ticketId, 'uat', null)).toThrow();
    // stage_current untouched, uat still pending
    expect(getTicket(store, ticketId).stageCurrent).toBe('scope');
    expect(stageOf(store, ticketId, 'uat').status).toBe('pending');
  });

  it('a stage with no edge for the verdict throws (e.g. fail at scope)', () => {
    expect(() => transition(store, ticketId, 'scope', { kind: 'failed' })).toThrow();
  });

  it('transitioning from done throws (terminal)', () => {
    expect(() => transition(store, ticketId, 'done', { kind: 'passed' })).toThrow();
  });

  it('a repeated fix loop climbs attempt each time', () => {
    transition(store, ticketId, 'uat', { kind: 'failed' }); // attempt 1
    transition(store, ticketId, 'fix', { kind: 'passed' }); // back to review
    transition(store, ticketId, 'review', { kind: 'failed' }); // review attempt 1
    transition(store, ticketId, 'fix', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'failed' }); // uat attempt 2
    expect(stageOf(store, ticketId, 'uat').attempt).toBe(2);
  });
});
