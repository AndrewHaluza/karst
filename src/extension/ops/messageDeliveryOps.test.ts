import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket, setAgentState, setStageCurrent } from '../../store/tickets.js';
import { markRead, postMessage } from '../../store/ticketMessages.js';
import { DELIVERY_READ_LIMIT } from '../../store/messageDelivery.js';
import { setStage } from '../../store/stages.js';
import type { MessageDelivery } from '../../workflow/messageDelivery.js';
import {
  EVENT_MAX_AGE_MS,
  POINTER_INTERVAL_MS,
  WAKE_COOLDOWN_MS,
  isAgyRecipient,
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
    refreshUnread: vi.fn(),
    wake: vi.fn(async () => {}),
    now: () => clock,
    debug: vi.fn(),
    warn: vi.fn(),
    ...over,
  };
}

/** The mail pointer the sweep passes for a recipient with `unread` rows. */
function ptr(unread: number): { kind: 'mail'; unread: number } {
  return { kind: 'mail', unread };
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
    expect(d.delivery.deliver).toHaveBeenCalledWith(parentId, ptr(2));
    clock += POINTER_INTERVAL_MS;
    expect(sweep.sweep().delivered).toEqual([]);
  });

  it('refreshes the in-memory unread cache from this sweep and passes the mail pointer', () => {
    const refreshUnread = vi.fn();
    const d = deps({ refreshUnread });
    const sweep = makeMessageDeliverySweep(d);
    send(parentId);
    send(parentId);
    sweep.sweep();
    expect(refreshUnread).toHaveBeenCalledWith([
      expect.objectContaining({ toTicketId: parentId, unread: 2 }),
    ]);
    expect(d.delivery.deliver).toHaveBeenCalledWith(parentId, ptr(2));
  });

  it('an armed delivery is not a delivery: no watermark, no count, logs the arm', () => {
    send(parentId);
    const deliver = vi.fn(() => 'armed' as const);
    const d = deps({ delivery: { deliver } });
    const sweep = makeMessageDeliverySweep(d);
    expect(sweep.sweep().delivered).toEqual([]);
    expect(deliver).toHaveBeenCalledWith(parentId, ptr(1));
    expect(d.debug).toHaveBeenCalledWith(expect.stringContaining('armed'));
    // The arm left no watermark, so the next sweep calls deliver again (an idle
    // recipient then gets typed instead of being stranded).
    sweep.sweep();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('alreadyPushed makes the sweep skip a batch the reply already delivered', () => {
    send(parentId);
    let pushedUpTo = 0;
    const deliver = vi.fn().mockReturnValue('delivered' as const);
    const alreadyPushed = vi.fn((_id: number, maxId: number) => maxId <= pushedUpTo);
    const d = deps({ delivery: { deliver }, alreadyPushed });
    const sweep = makeMessageDeliverySweep(d);
    // The turn-end reply pushed this batch before the sweep ran.
    pushedUpTo = 1;
    expect(sweep.sweep().delivered).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    expect(d.debug).toHaveBeenCalledWith(expect.stringContaining('already pushed'));
    // The skip recorded the watermark, so the next tick does not even re-check.
    expect(sweep.sweep().delivered).toEqual([]);
    expect(alreadyPushed).toHaveBeenCalledTimes(1);
    // A NEW batch (higher watermark) is still delivered: only THIS one is known.
    send(parentId);
    expect(sweep.sweep().delivered).toEqual([parentId]);
  });

  it('reload: a backlog yields exactly one pointer on first sight', () => {
    for (let i = 0; i < 5; i++) send(parentId);
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    sweep.sweep();
    clock += POINTER_INTERVAL_MS * 3;
    sweep.sweep();
    expect(d.delivery.deliver).toHaveBeenCalledTimes(1);
    expect(d.delivery.deliver).toHaveBeenCalledWith(parentId, ptr(5));
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
    expect(d.delivery.deliver).toHaveBeenLastCalledWith(parentId, ptr(3));
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

function debugLines(d: MessageDeliveryDeps): string[] {
  return vi.mocked(d.debug).mock.calls.map(([m]) => String(m));
}

describe('message delivery sweep — pointer logging and bounds', () => {
  it('logs delivered, rate-limited, and deferred pointers with the recipient and count', () => {
    let result: 'delivered' | 'deferred' = 'delivered';
    const d = deps({ delivery: { deliver: vi.fn(() => result) } });
    const sweep = makeMessageDeliverySweep(d);
    send(parentId);
    sweep.sweep();
    expect(debugLines(d)).toContain(`[driver] delivery #${parentId}: pointer delivered (1 unread)`);
    send(parentId);
    clock += 1_000;
    sweep.sweep();
    expect(debugLines(d)).toContain(`[driver] delivery #${parentId}: rate-limited — coalescing`);
    clock += POINTER_INTERVAL_MS;
    result = 'deferred';
    sweep.sweep();
    expect(debugLines(d)).toContain(`[driver] delivery #${parentId}: deferred (2 unread)`);
  });

  it('summarizes pointers and wakes only when something happened', () => {
    const idle = deps();
    makeMessageDeliverySweep(idle).sweep();
    expect(debugLines(idle).some((m) => m.includes('pointer(s)'))).toBe(false);

    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    send(parentId);
    sweep.sweep();
    expect(debugLines(d)).toContain('[driver] delivery: 1 pointer(s), 0 wake(s)');

    const both = deps();
    const sweepBoth = makeMessageDeliverySweep(both);
    send(parentId);
    setStage(store, childId, 'impl', { blockedKind: 'boot-failed', blockedReason: 'x' });
    expect(sweepBoth.sweep()).toEqual({ delivered: [parentId], woke: [parentId] });
    expect(debugLines(both)).toContain('[driver] delivery: 1 pointer(s), 1 wake(s)');
  });

  it('a throwing delivery is logged at debug with its message, and the wake pass still runs', () => {
    send(parentId);
    const d = deps({ delivery: { deliver: () => { throw new Error('boom'); } } });
    const sweep = makeMessageDeliverySweep(d);
    setStage(store, childId, 'impl', { blockedKind: 'boot-failed', blockedReason: 'x' });
    expect(sweep.sweep().woke).toEqual([parentId]);
    expect(debugLines(d)).toContain('[driver] delivery: pointer pass failed — boom');
  });

  it('with no bound project nothing is read, logged, or warned', () => {
    send(parentId);
    const d = deps({ projectId: () => undefined });
    makeMessageDeliverySweep(d).sweep();
    expect(d.debug).not.toHaveBeenCalled();
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('a disposed sweep does not even resolve the project', () => {
    send(parentId);
    const projectOf = vi.fn(() => projectId);
    const d = deps({ projectId: projectOf });
    const sweep = makeMessageDeliverySweep(d);
    sweep.dispose();
    expect(sweep.sweep()).toEqual({ delivered: [], woke: [] });
    expect(projectOf).not.toHaveBeenCalled();
  });

  it('a re-entrant sweep logs that it was skipped', () => {
    send(parentId);
    let sweeper: ReturnType<typeof makeMessageDeliverySweep>;
    const d = deps({
      delivery: {
        deliver: () => {
          sweeper.sweep();
          return 'delivered';
        },
      },
    });
    sweeper = makeMessageDeliverySweep(d);
    sweeper.sweep();
    expect(debugLines(d)).toContain('[driver] delivery: sweep already running — skipping');
  });

  it('a truncated unread read does not forget recipients it could not see', () => {
    // Heads get lower ids than the later-created `highTail`, so an id-ordered,
    // LIMIT-ed read of the heads drops `highTail`.
    const heads: number[] = [];
    for (let i = 0; i < DELIVERY_READ_LIMIT; i++) {
      heads.push(createTicket(store, { key: `P-H${i}`, title: 'h', projectId }).id);
    }
    const highTail = createTicket(store, { key: 'P-HIGH', title: 'h', projectId }).id;
    const post = (to: number): number =>
      postMessage(store, { projectId, fromTicketId: parentId, toTicketId: to, kind: 'message', body: 'm' }).id;
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    post(highTail);
    sweep.sweep();
    expect(d.delivery.deliver).toHaveBeenCalledTimes(1);
    const headRows = heads.map(post);
    sweep.sweep(); // 200 heads fill the read; highTail is truncated away
    expect(d.delivery.deliver).toHaveBeenCalledTimes(1 + DELIVERY_READ_LIMIT);
    markRead(store, headRows);
    clock += POINTER_INTERVAL_MS * 2;
    sweep.sweep(); // only highTail is unread again; its watermark must still stand
    expect(d.delivery.deliver).toHaveBeenCalledTimes(1 + DELIVERY_READ_LIMIT);
  });
});

describe('message delivery sweep — wake aging, cooldown, and failure paths', () => {
  function block(id: number, stage: 'impl' | 'fix' = 'impl'): void {
    setStage(store, id, stage, { blockedKind: 'boot-failed', blockedReason: 'need creds' });
  }
  function eventCreatedMs(): number {
    const row = store.db.prepare("SELECT created_at AS c FROM ticket_messages WHERE kind = 'event' ORDER BY id LIMIT 1").get() as {
      c: string;
    };
    return Date.parse(`${row.c.replace(' ', 'T')}Z`);
  }
  function claimedCount(): number {
    return (store.db.prepare("SELECT COUNT(*) AS n FROM ticket_messages WHERE kind = 'event' AND woke_at IS NOT NULL").get() as {
      n: number;
    }).n;
  }

  it('an event exactly at the age cutoff still retries; one millisecond past is skipped as aged out', () => {
    setStageCurrent(store, parentId, 'review');
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    clock = eventCreatedMs() + EVENT_MAX_AGE_MS;
    sweep.sweep();
    expect(claimedCount()).toBe(0);
    clock += 1;
    sweep.sweep();
    expect(claimedCount()).toBe(1);
    expect(debugLines(d).some((m) => m.endsWith(`-> #${parentId}: skip — aged out (parent at review)`))).toBe(true);
  });

  it('a terminal skip keeps its own reason even when the event is old', () => {
    setStageCurrent(store, parentId, 'ship');
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    clock = eventCreatedMs() + EVENT_MAX_AGE_MS + 60_000;
    sweep.sweep();
    const lines = debugLines(d).filter((m) => m.includes('delivery wake event'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`-> #${parentId}: skip — parent at ship$`));
  });

  it('logs the wake decision with the event id, parent, and reason', () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    sweep.sweep();
    const row = store.db.prepare("SELECT id FROM ticket_messages WHERE kind = 'event' ORDER BY id LIMIT 1").get() as { id: number };
    expect(debugLines(d)).toContain(`[driver] delivery wake event ${row.id} -> #${parentId}: wake — child blocked`);
  });

  it('a second wake inside the cooldown retries with a cooldown reason, then wakes at exactly the cooldown', async () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    const t0 = clock;
    expect(sweep.sweep().woke).toEqual([parentId]);
    await Promise.resolve();
    await Promise.resolve();
    block(childId, 'fix');
    clock = t0 + WAKE_COOLDOWN_MS - 1;
    expect(sweep.sweep().woke).toEqual([]);
    expect(debugLines(d).some((m) => m.endsWith('retry — wake cooldown'))).toBe(true);
    expect(claimedCount()).toBe(1);
    clock = t0 + WAKE_COOLDOWN_MS;
    expect(sweep.sweep().woke).toEqual([parentId]);
    expect(d.wake).toHaveBeenCalledTimes(2);
  });

  it('a cooldown applies to wakes only: a skip inside the cooldown is claimed, not retried', async () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    sweep.sweep();
    await Promise.resolve();
    await Promise.resolve();
    setStageCurrent(store, parentId, 'ship');
    block(childId, 'fix');
    clock += 1_000;
    sweep.sweep();
    expect(claimedCount()).toBe(2);
  });

  it('a synchronously throwing wake warns, clears the open marker, and can wake again later', () => {
    const wake = vi.fn(() => {
      throw new Error('sync open failure');
    });
    const d = deps({ wake });
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([parentId]);
    expect(d.warn).toHaveBeenCalledWith(`karst: waking ticket #${parentId} failed: sync open failure`);
    block(childId, 'fix');
    clock += WAKE_COOLDOWN_MS;
    expect(sweep.sweep().woke).toEqual([parentId]);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('a rejected wake warns with the ticket and reason', async () => {
    const d = deps({ wake: vi.fn(async () => { throw new Error('open failed'); }) });
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    sweep.sweep();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.warn).toHaveBeenCalledWith(`karst: waking ticket #${parentId} failed: open failed`);
  });

  it('an event another window claimed mid-decision is logged and not woken', () => {
    const d = deps({
      isLive: () => {
        store.db.prepare("UPDATE ticket_messages SET woke_at = datetime('now') WHERE kind = 'event'").run();
        return false;
      },
    });
    const sweep = makeMessageDeliverySweep(d);
    block(childId);
    expect(sweep.sweep().woke).toEqual([]);
    expect(d.wake).not.toHaveBeenCalled();
    const row = store.db.prepare("SELECT id FROM ticket_messages WHERE kind = 'event' ORDER BY id LIMIT 1").get() as { id: number };
    expect(debugLines(d)).toContain(`[driver] delivery wake event ${row.id}: claimed elsewhere`);
  });

  it('dispose from inside a wake stops the remaining events', () => {
    const parent2 = createTicket(store, { key: 'P-2', title: 'p2', projectId }).id;
    const child2 = createTicket(store, { key: 'P-2-s1', title: 'c', projectId, subtaskParentId: parent2, blocksParent: true }).id;
    setStageCurrent(store, parent2, 'impl');
    setStageCurrent(store, child2, 'impl');
    let sweeper: ReturnType<typeof makeMessageDeliverySweep>;
    const wake = vi.fn(() => {
      sweeper.dispose();
    });
    sweeper = makeMessageDeliverySweep(deps({ wake }));
    block(childId);
    block(child2);
    expect(sweeper.sweep().woke).toEqual([parentId]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(parentId);
  });
});

describe('isAgyRecipient', () => {
  const sessions = (provider?: string) => ({
    sessionIdentity: () => (provider === undefined ? null : { provider }),
  });
  const configured = (provider: string | null) => () => provider;

  it('reads the session’s recorded identity first', () => {
    expect(isAgyRecipient(1, sessions('antigravity'), configured('claude'))).toBe(true);
    expect(isAgyRecipient(1, sessions('claude'), configured('antigravity'))).toBe(false);
  });

  it('falls back to the configured provider when the session has no recorded identity', () => {
    expect(isAgyRecipient(1, sessions(), configured('antigravity'))).toBe(true);
    expect(isAgyRecipient(1, sessions(), configured('claude'))).toBe(false);
    expect(isAgyRecipient(1, sessions(), configured(null))).toBe(false);
  });

  it('lets a core switch AWAY from agy deliver immediately (no stale agy gate)', () => {
    // The retired agy watch state survives a switch, but the replacement is
    // claude, so the gate must read the CURRENT session, not the leftover.
    expect(isAgyRecipient(1, sessions('claude'), configured('claude'))).toBe(false);
  });
});

