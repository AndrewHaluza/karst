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

  function blockedTicket(key: string, stage: 'review' | 'ship' | 'impl', kind: string): number {
    const t = createTicket(store, { key, title: 'thing' });
    setStage(store, t.id, stage, {
      status: stage === 'ship' ? 'passed' : 'running',
      blockedKind: kind as never,
      blockedReason: 'some reason',
      blockedAt: '2026-07-16T10:00:00.000Z',
    });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, t.id);
    return t.id;
  }

  it('clears the block and reports success when the ticket is at the blocked stage', () => {
    const id = blockedTicket('RB-1', 'review', 'nothing-to-run');
    const result = resumeBlockedStage(store, id, id, 'review');
    expect(result).toEqual({ kind: 'cleared' });
    expect(stageBlock(store, id, 'review')).toBeNull();
  });

  it('refuses a message naming a different ticket than the one the panel owns', () => {
    const id = blockedTicket('RB-2', 'review', 'nothing-to-run');
    const result = resumeBlockedStage(store, id, id + 1, 'review');
    expect(result).toEqual({ kind: 'refused' });
    expect(stageBlock(store, id, 'review')).not.toBeNull();
  });

  it('refuses to resume a stage the ticket has since left', () => {
    const id = blockedTicket('RB-3', 'review', 'nothing-to-run');
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(id);
    const result = resumeBlockedStage(store, id, id, 'review');
    expect(result).toEqual({ kind: 'refused' });
    expect(stageBlock(store, id, 'review')).not.toBeNull();
  });

  it('refuses when the named stage carries no block at all', () => {
    const t = createTicket(store, { key: 'RB-4', title: 'thing' });
    setStage(store, t.id, 'review', { status: 'running' });
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(t.id);
    expect(resumeBlockedStage(store, t.id, t.id, 'review')).toEqual({ kind: 'refused' });
  });

  it('refuses to clear an awaiting-merge block — only the merge gate is entitled to', () => {
    const id = blockedTicket('RB-5', 'ship', 'awaiting-merge');
    const result = resumeBlockedStage(store, id, id, 'ship');
    expect(result).toEqual({ kind: 'refused' });
    expect(stageBlock(store, id, 'ship')?.kind).toBe('awaiting-merge');
  });

  it('an approach-graph-failed block returns the typed graph-recovery action, never clears', () => {
    const id = blockedTicket('RB-6', 'impl', 'approach-graph-failed');
    const runId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
           VALUES (?, 'impl', 0, 'x', 'blocked', 'resource-claim-violated: b.ts', '2026-08-12T00:00:00.000Z')`,
        )
        .run(id)
        .lastInsertRowid,
    );
    const result = resumeBlockedStage(store, id, id, 'impl');
    expect(result).toEqual({ kind: 'graph-recovery', ticketId: id, graphRunId: runId });
    expect(stageBlock(store, id, 'impl')?.kind).toBe('approach-graph-failed');
  });

  it('a graph-failed block with no blocked graph run refuses (stale)', () => {
    const id = blockedTicket('RB-7', 'impl', 'approach-graph-failed');
    expect(resumeBlockedStage(store, id, id, 'impl')).toEqual({ kind: 'refused' });
  });
});
