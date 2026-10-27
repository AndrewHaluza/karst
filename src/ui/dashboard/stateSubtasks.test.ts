import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import { buildDashboardState } from './state.js';

describe('dashboard sub-task rows (D277 host data)', () => {
  let store: Store;
  let parentId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    parentId = createTicket(store, { key: 'FEAT-1', title: 'root' }).id;
  });
  afterEach(() => store.close());

  function child(opts: { stage?: string; queued?: boolean; blocking?: boolean } = {}): number {
    const t = createTicket(store, {
      key: `FEAT-1-s${Math.random().toString(36).slice(2, 6)}`,
      title: 'c',
      subtaskParentId: parentId,
      autostartPending: opts.queued,
      blocksParent: opts.blocking,
    });
    if (opts.stage) store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(opts.stage, t.id);
    return t.id;
  }
  const park = (id: number, stage: 'impl' | 'ship', kind: Parameters<typeof parkGateStage>[1]['kind'], reason: string, runAt = '2026-08-09T10:33:42.000Z') =>
    parkGateStage(store, { ticketId: id, stageKey: stage, kind, reason, runAt, gates: [] });
  const row = (id: number) => buildDashboardState(store, parentId).subtasks.find((r) => r.id === id)!;

  it('fault: a usage-limit park carries the shared title, reason and the block start', () => {
    const id = child({ stage: 'impl' });
    setStage(store, id, 'impl', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    park(id, 'impl', 'usage-limit', 'anthropic: monthly quota exceeded');
    expect(row(id).fault).toEqual({
      kind: 'usage-limit',
      title: 'Provider out of quota',
      reason: 'anthropic: monthly quota exceeded',
      since: '2026-08-09T10:33:42.000Z',
    });
  });

  it('fault: a gate park titles the stage', () => {
    const id = child({ stage: 'impl' });
    setStage(store, id, 'impl', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    park(id, 'impl', 'nothing-to-run', 'no target resolved');
    expect(row(id).fault?.title).toBe('Implementation is blocked');
  });

  it('fault: awaiting-merge, a done child and an unblocked child have none', () => {
    const waiting = child({ stage: 'ship' });
    setStage(store, waiting, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    park(waiting, 'ship', 'awaiting-merge', 'PR #1 is open');
    const done = child({ stage: 'done' });
    setStage(store, done, 'impl', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    park(done, 'impl', 'nothing-to-run', 'stale');
    const plain = child({ stage: 'impl' });
    expect([waiting, done, plain].map((id) => row(id).fault)).toEqual([null, null, null]);
  });

  it('stageSince: the current stage start, or null before one', () => {
    const id = child({ stage: 'impl' });
    setStage(store, id, 'impl', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    expect(row(id).stageSince).toBe('2026-08-09T10:00:00.000Z');
    expect(row(child()).stageSince).toBeNull();
  });

  it('pr: the current PR with its state and how many more repos have one', () => {
    const id = child({ stage: 'ship' });
    const ins = store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)');
    ins.run(id, '/a', 418, 'https://x/418', 'merged');
    ins.run(id, '/b', 419, 'https://x/419', 'open');
    expect(row(id).pr).toEqual({ number: 418, state: 'merged', more: 1 });
    expect(row(child()).pr).toBeNull();
  });

  it('agent: the child’s resolved core and model, only while it has a session or is in an agent stage', () => {
    const running = child({ stage: 'impl' });
    store.db.prepare("UPDATE tickets SET agent_provider = 'codex' WHERE id = ?").run(running);
    expect(row(running).agent).toMatchObject({ core: 'codex', coreLabel: expect.any(String) });
    expect(row(child({ stage: 'done' })).agent).toBeNull();
    expect(row(child({ stage: 'scope' })).agent).toBeNull();
  });

  it('queuePos: 1-based in sweep order, null for rows not queued', () => {
    const a = child({ queued: true });
    const b = child({ queued: true, blocking: true });
    const idle = child();
    expect([a, b, idle].map((id) => row(id).queuePos)).toEqual([2, 1, null]);
  });
});
