import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket, setAgentState, setStageCurrent } from '../../store/tickets.js';
import { markRead, postMessage } from '../../store/ticketMessages.js';
import { setStage } from '../../store/stages.js';
import type { MessageDelivery } from '../../workflow/messageDelivery.js';
import {
  POINTER_INTERVAL_MS,
  makeMessageDeliverySweep,
  type MessageDeliveryDeps,
} from './messageDeliveryOps.js';

let store: Store;
let projectId: number;
let parentId: number;
let childId: number;
let clock: number;

function send(to: number, kind: 'message' | 'event' = 'message', body = 'hello'): number {
  return postMessage(store, {
    projectId,
    fromTicketId: kind === 'event' ? null : to === parentId ? childId : parentId,
    toTicketId: to,
    kind,
    body,
  }).id;
}

function delivery(result: 'delivered' | 'deferred' = 'delivered'): MessageDelivery & { deliver: ReturnType<typeof vi.fn> } {
  return { deliver: vi.fn(() => result) };
}

function deps(over: Partial<MessageDeliveryDeps> = {}): MessageDeliveryDeps {
  return {
    store,
    projectId: () => projectId,
    delivery: delivery(),
    isLive: () => false,
    graphOwned: () => false,
    wake: vi.fn(),
    now: () => clock,
    debug: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  store = openStore(':memory:');
  projectId = upsertProject(store, { slug: 'p' }).id;
  parentId = createTicket(store, { key: 'P-1', title: 'parent', projectId }).id;
  childId = createTicket(store, {
    key: 'P-1-s1',
    title: 'c',
    projectId,
    subtaskParentId: parentId,
    blocksParent: true,
  }).id;
  setStageCurrent(store, parentId, 'impl');
  setStageCurrent(store, childId, 'impl');
  clock = 1_000_000;
});

describe('message delivery sweep — pointers', () => {
  it('delivers once per new batch and never again for the same rows', () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    send(parentId);
    send(parentId);
    expect(sweep.sweep().delivered).toEqual([parentId]);
    expect(d.delivery.deliver).toHaveBeenCalledWith(parentId, 2);
    clock += POINTER_INTERVAL_MS;
    expect(sweep.sweep().delivered).toEqual([]);
  });

  it('reload: a backlog yields exactly one pointer on first sight', () => {
    for (let i = 0; i < 5; i++) send(parentId);
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    sweep.sweep();
    clock += POINTER_INTERVAL_MS * 3;
    sweep.sweep();
    expect(d.delivery.deliver).toHaveBeenCalledTimes(1);
    expect(d.delivery.deliver).toHaveBeenCalledWith(parentId, 5);
  });

  it('read rows produce no pointer', () => {
    markRead(store, [send(parentId)]);
    const d = deps();
    makeMessageDeliverySweep(d).sweep();
    expect(d.delivery.deliver).not.toHaveBeenCalled();
  });

  it('rate-limits to one pointer per 30s and coalesces arrivals into the next count', () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    send(parentId);
    sweep.sweep();
    send(parentId);
    clock += 10_000;
    sweep.sweep();
    send(parentId);
    clock += 10_000;
    sweep.sweep();
    expect(d.delivery.deliver).toHaveBeenCalledTimes(1);
    clock += 10_000;
    sweep.sweep();
    expect(d.delivery.deliver).toHaveBeenCalledTimes(2);
    expect(d.delivery.deliver).toHaveBeenLastCalledWith(parentId, 3);
    expect(POINTER_INTERVAL_MS).toBe(30_000);
  });

  it('a deferred delivery (not live / graph) retries and lands once when it becomes deliverable', () => {
    let result: 'delivered' | 'deferred' = 'deferred';
    const d = deps({ delivery: { deliver: vi.fn(() => result) } });
    const sweep = makeMessageDeliverySweep(d);
    send(childId);
    sweep.sweep();
    sweep.sweep();
    expect(d.delivery.deliver).toHaveBeenCalledTimes(2);
    result = 'delivered';
    expect(sweep.sweep().delivered).toEqual([childId]);
    clock += POINTER_INTERVAL_MS;
    sweep.sweep();
    expect(d.delivery.deliver).toHaveBeenCalledTimes(3);
  });

  it('does nothing when no project is bound', () => {
    send(parentId);
    const d = deps({ projectId: () => undefined });
    expect(makeMessageDeliverySweep(d).sweep()).toEqual({ delivered: [], woke: [] });
  });

  it('a throwing delivery does not break the sweep', () => {
    send(parentId);
    const d = deps({ delivery: { deliver: () => { throw new Error('boom'); } } });
    expect(makeMessageDeliverySweep(d).sweep()).toEqual({ delivered: [], woke: [] });
  });

  it('dispose mid-sweep stops further deliveries', () => {
    const other = createTicket(store, { key: 'P-2', title: 'x', projectId }).id;
    send(parentId);
    send(other, 'event', 'P-9 landed (done)');
    let sweeper: ReturnType<typeof makeMessageDeliverySweep>;
    const deliver = vi.fn(() => {
      sweeper.dispose();
      return 'delivered' as const;
    });
    sweeper = makeMessageDeliverySweep(deps({ delivery: { deliver } }));
    sweeper.sweep();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sweeper.sweep()).toEqual({ delivered: [], woke: [] });
  });

  it('re-entrant sweep is skipped', () => {
    send(parentId);
    let sweeper: ReturnType<typeof makeMessageDeliverySweep>;
    let inner: unknown;
    const deliver = vi.fn(() => {
      inner = sweeper.sweep();
      return 'delivered' as const;
    });
    sweeper = makeMessageDeliverySweep(deps({ delivery: { deliver } }));
    sweeper.sweep();
    expect(inner).toEqual({ delivered: [], woke: [] });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('message delivery sweep — parent wake', () => {
  function block(id: number): void {
    setStage(store, id, 'impl', { blockedKind: 'boot-failed', blockedReason: 'need creds' });
  }

  it('wakes a not-live parent at impl when a child is blocked', () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([parentId]);
    expect(d.wake).toHaveBeenCalledWith(parentId);
    expect(sweep.sweep().woke).toEqual([]);
  });

  it('wakes on the last blocking child landing', () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    send(parentId, 'event', 'P-1-s1 landed (done)');
    expect(sweep.sweep().woke).toEqual([]);
    setStageCurrent(store, childId, 'done');
    send(parentId, 'event', 'P-1-s1 landed (done)');
    expect(sweep.sweep().woke).toEqual([parentId]);
  });

  it('never wakes while an awaiting-subtask park is on any parent stage, and retries after it clears', () => {
    setStageCurrent(store, childId, 'done');
    setStage(store, parentId, 'impl', {
      blockedKind: 'awaiting-subtask',
      blockedReason: 'merge conflict integrating P-1-s1',
    });
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    send(parentId, 'event', 'P-1-s1 landed (done)');
    expect(sweep.sweep().woke).toEqual([]);
    setStage(store, parentId, 'impl', { blockedKind: null, blockedReason: null });
    expect(sweep.sweep().woke).toEqual([parentId]);
  });

  it.each(['ship', 'done', 'review'] as const)('no wake for a parent at %s', (stage) => {
    setStageCurrent(store, parentId, stage);
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('no wake for an archived or graph-owned parent', () => {
    const d = deps({ graphOwned: (id) => id === parentId });
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    const d2 = deps();
    const s2 = makeMessageDeliverySweep(d2);
    // Raw write: archiveTicket refuses a parent with open sub-tasks.
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(parentId);
    send(parentId, 'event', 'P-1-s1 blocked at impl: again');
    expect(s2.sweep().woke).toEqual([]);
    expect(d2.wake).not.toHaveBeenCalled();
  });

  it('no wake when the parent is live here or running elsewhere', () => {
    const here = deps({ isLive: (id) => id === parentId });
    const sweep = makeMessageDeliverySweep(here);
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    expect(here.wake).not.toHaveBeenCalled();

    setAgentState(store, parentId, 'running');
    const elsewhere = deps();
    const s2 = makeMessageDeliverySweep(elsewhere);
    send(parentId, 'event', 'P-1-s1 blocked at fix: again');
    expect(s2.sweep().woke).toEqual([]);
  });

  it('a plain message never wakes', () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    send(parentId, 'message', 'P-1-s1 landed (done)');
    expect(sweep.sweep().woke).toEqual([]);
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('events before activation never wake (reload)', () => {
    block(childId);
    const d = deps();
    expect(makeMessageDeliverySweep(d).sweep().woke).toEqual([]);
  });

  it('two windows on one DB file: the woke_at claim wakes once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-wake-'));
    const path = join(dir, 'karst.db');
    const s1 = openStore(path);
    const s2 = openStore(path);
    try {
      const pid = upsertProject(s1, { slug: 'p' }).id;
      const parent = createTicket(s1, { key: 'P-1', title: 'p', projectId: pid }).id;
      const kid = createTicket(s1, { key: 'P-1-s1', title: 'c', projectId: pid, subtaskParentId: parent }).id;
      setStageCurrent(s1, parent, 'impl');
      const mk = (st: Store) => deps({ store: st, projectId: () => pid });
      const a = mk(s1);
      const b = mk(s2);
      const sa = makeMessageDeliverySweep(a);
      const sb = makeMessageDeliverySweep(b);
      setStage(s1, kid, 'impl', { blockedKind: 'boot-failed', blockedReason: 'x' });
      expect([...sb.sweep().woke, ...sa.sweep().woke]).toEqual([parent]);
      expect(vi.mocked(a.wake).mock.calls.length + vi.mocked(b.wake).mock.calls.length).toBe(1);
    } finally {
      s1.close();
      s2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
