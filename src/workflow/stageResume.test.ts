import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { stageBlock } from '../store/stageBlocks.js';
import { resumeBlockedStage } from './stageResume.js';

/**
 * The host-side decision behind the dashboard's Resume button (§ blocked
 * state visible). The webview message carries its own ticketId/stageKey, but
 * neither is trusted — this is where both are checked against the ticket the
 * panel actually owns, right before the store is mutated.
 */
describe('resumeBlockedStage', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('clears the block and reports success when the ticket is at the blocked stage', () => {
    const t = createTicket(store, { key: 'RB-1', title: 'thing' });
    setStage(store, t.id, 'review', {
      status: 'running',
      blockedKind: 'nothing-to-run',
      blockedReason: 'no target resolved',
      blockedAt: '2026-07-16T10:00:00.000Z',
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(t.id);

    const ok = resumeBlockedStage(store, t.id, t.id, 'review');

    expect(ok).toBe(true);
    expect(stageBlock(store, t.id, 'review')).toBeNull();
  });

  it('refuses a message naming a different ticket than the one the panel owns', () => {
    const t = createTicket(store, { key: 'RB-2', title: 'thing' });
    setStage(store, t.id, 'review', {
      status: 'running',
      blockedKind: 'nothing-to-run',
      blockedReason: 'no target resolved',
      blockedAt: '2026-07-16T10:00:00.000Z',
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(t.id);

    const ok = resumeBlockedStage(store, t.id, t.id + 1, 'review');

    expect(ok).toBe(false);
    expect(stageBlock(store, t.id, 'review')).not.toBeNull();
  });

  it('refuses to resume a stage the ticket has since left', () => {
    const t = createTicket(store, { key: 'RB-3', title: 'thing' });
    setStage(store, t.id, 'review', {
      status: 'running',
      blockedKind: 'nothing-to-run',
      blockedReason: 'no target resolved',
      blockedAt: '2026-07-16T10:00:00.000Z',
    });
    // The ticket moved on (e.g. an earlier retry already cleared and advanced
    // it) — a stale panel's message must not touch a stage the ticket left.
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);

    const ok = resumeBlockedStage(store, t.id, t.id, 'review');

    expect(ok).toBe(false);
    expect(stageBlock(store, t.id, 'review')).not.toBeNull();
  });

  it('refuses when the named stage carries no block at all', () => {
    const t = createTicket(store, { key: 'RB-4', title: 'thing' });
    setStage(store, t.id, 'review', { status: 'running' });
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(t.id);

    const ok = resumeBlockedStage(store, t.id, t.id, 'review');

    expect(ok).toBe(false);
  });

  it('refuses to clear an awaiting-merge block — only the merge gate is entitled to', () => {
    // Unlike every other BlockerKind, awaiting-merge does not mean "karst
    // could not ask the question, retry it" — the question WAS asked (ship
    // opened its PRs) and answered "not yet". A Resume click here cannot make
    // a PR merge; only settleShipGate, observing the actual landing, may
    // clear this block. Clearing it any other way strands the ticket at
    // `ship` forever, because settleShipGate requires this exact block to
    // distinguish "waiting to land" from "parked pending the first confirm".
    const t = createTicket(store, { key: 'RB-5', title: 'thing' });
    setStage(store, t.id, 'ship', {
      status: 'passed',
      blockedKind: 'awaiting-merge',
      blockedReason: 'blocked: the pull request for "api" has changes and is not merged yet.',
      blockedAt: '2026-07-16T10:00:00.000Z',
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);

    const ok = resumeBlockedStage(store, t.id, t.id, 'ship');

    expect(ok).toBe(false);
    expect(stageBlock(store, t.id, 'ship')?.kind).toBe('awaiting-merge');
  });
});
