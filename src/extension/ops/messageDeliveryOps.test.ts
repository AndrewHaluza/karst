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
  EVENT_MAX_AGE_MS,
  POINTER_INTERVAL_MS,
  WAKE_COOLDOWN_MS,
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
    isGraphTicket: () => false,
    integrating: () => false,
    wake: vi.fn(async () => {}),
    now: () => clock,
    debug: vi.fn(),
    warn: vi.fn(),
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
  clock = Date.now();
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

  it('a recipient that read everything is forgotten: its next message points at once', () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    const first = send(parentId);
    sweep.sweep();
    markRead(store, [first]);
    sweep.sweep();
    clock += 1_000;
    send(parentId);
    sweep.sweep();
    expect(d.delivery.deliver).toHaveBeenCalledTimes(2);
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
  function block(id: number, stage: 'impl' | 'fix' = 'impl'): void {
    setStage(store, id, stage, { blockedKind: 'boot-failed', blockedReason: 'need creds' });
  }
  function wokeAt(): Array<string | null> {
    return (store.db.prepare("SELECT woke_at FROM ticket_messages WHERE kind = 'event' ORDER BY id").all() as {
      woke_at: string | null;
    }[]).map((r) => r.woke_at);
  }

  it('wakes a not-live parent at impl when a child is blocked, once', () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([parentId]);
    expect(d.wake).toHaveBeenCalledWith(parentId);
    clock += WAKE_COOLDOWN_MS;
    expect(sweep.sweep().woke).toEqual([]);
  });

  it('wakes on the last blocking child landing; an earlier landing with blockers open retries', () => {
    const second = createTicket(store, { key: 'P-1-s2', title: 'c2', projectId, subtaskParentId: parentId, blocksParent: true }).id;
    setStageCurrent(store, second, 'impl');
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    setStageCurrent(store, childId, 'done');
    send(parentId, 'event', 'P-1-s1 landed (done)');
    expect(sweep.sweep().woke).toEqual([]);
    expect(wokeAt()).toEqual([null]);
    setStageCurrent(store, second, 'done');
    send(parentId, 'event', 'P-1-s2 landed (done)');
    expect(sweep.sweep().woke).toEqual([parentId]);
  });

  it('a landing holds on any awaiting-subtask park, then wakes once it clears', () => {
    setStageCurrent(store, childId, 'done');
    setStage(store, parentId, 'impl', { blockedKind: 'awaiting-subtask', blockedReason: 'waiting on P-1-s1 (impl)' });
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    send(parentId, 'event', 'P-1-s1 landed (done)');
    expect(sweep.sweep().woke).toEqual([]);
    setStage(store, parentId, 'impl', { blockedKind: null, blockedReason: null });
    expect(sweep.sweep().woke).toEqual([parentId]);
  });

  it('a child-blocked event wakes through a plain gate wait', () => {
    setStage(store, parentId, 'impl', { blockedKind: 'awaiting-subtask', blockedReason: 'waiting on P-1-s1 (impl)' });
    const sweep = makeMessageDeliverySweep(deps());
    block(childId);
    expect(sweep.sweep().woke).toEqual([parentId]);
  });

  it('a child-blocked event holds on an integration park', () => {
    setStage(store, parentId, 'impl', { blockedKind: 'awaiting-subtask', blockedReason: 'merge conflict integrating P-1-s1' });
    const sweep = makeMessageDeliverySweep(deps());
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    expect(wokeAt()).toEqual([null]);
  });

  it('holds while integration is in flight, even before any park', () => {
    let busy = true;
    const sweep = makeMessageDeliverySweep(deps({ integrating: () => busy }));
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    busy = false;
    expect(sweep.sweep().woke).toEqual([parentId]);
  });

  it.each(['ship', 'done'] as const)('a parent at %s is a terminal skip (claimed, never woken)', (stage) => {
    setStageCurrent(store, parentId, stage);
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    expect(wokeAt()[0]).not.toBeNull();
    expect(d.wake).not.toHaveBeenCalled();
  });

  it.each(['fix', 'review', 'uat', 'scope'] as const)('a parent at %s retries (unclaimed), never wakes', (stage) => {
    setStageCurrent(store, parentId, stage);
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    expect(wokeAt()).toEqual([null]);
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('a retry older than the age cutoff is claimed and skipped', () => {
    setStageCurrent(store, parentId, 'review');
    const sweep = makeMessageDeliverySweep(deps());
    block(childId);
    sweep.sweep();
    expect(wokeAt()).toEqual([null]);
    clock += EVENT_MAX_AGE_MS + 60_000;
    setStageCurrent(store, parentId, 'impl');
    expect(sweep.sweep().woke).toEqual([]);
    expect(wokeAt()[0]).not.toBeNull();
  });

  it('no wake for a graph ticket (approach or surface), claimed', () => {
    const d = deps({ isGraphTicket: (id) => id === parentId });
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    expect(wokeAt()[0]).not.toBeNull();
  });

  it('no wake for an archived parent', () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    // Raw write: archiveTicket refuses a parent with open sub-tasks.
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(parentId);
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('live here or running elsewhere retries rather than claims', () => {
    let live = true;
    const d = deps({ isLive: (id) => live && id === parentId });
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    expect(wokeAt()).toEqual([null]);
    live = false;
    setAgentState(store, parentId, 'running');
    expect(sweep.sweep().woke).toEqual([]);
    expect(wokeAt()).toEqual([null]);
    setAgentState(store, parentId, 'idle');
    expect(sweep.sweep().woke).toEqual([parentId]);
  });

  it('cooldown: a second event right after a wake waits, and an open in progress counts as live', async () => {
    let finish!: () => void;
    const d = deps({ wake: vi.fn(() => new Promise<void>((r) => (finish = r))) });
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([parentId]);
    block(childId, 'fix');
    clock += WAKE_COOLDOWN_MS + 1;
    expect(sweep.sweep().woke).toEqual([]);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(sweep.sweep().woke).toEqual([parentId]);
    expect(d.wake).toHaveBeenCalledTimes(2);
  });

  it('a rejected wake is reported at warn', async () => {
    const d = deps({ wake: vi.fn(async () => { throw new Error('open failed'); }) });
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    sweep.sweep();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('open failed'));
  });

  it('a throwing wake read is reported at warn', () => {
    const d = deps({ integrating: () => { throw new Error('boom'); } });
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    sweep.sweep();
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('a retry debug line is logged once per row and reason', () => {
    setStageCurrent(store, parentId, 'review');
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    sweep.sweep();
    sweep.sweep();
    sweep.sweep();
    const lines = vi.mocked(d.debug).mock.calls.filter(([m]) => String(m).includes('retry'));
    expect(lines).toHaveLength(1);
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
