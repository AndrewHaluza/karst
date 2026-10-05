import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket, findTicketById, setStageCurrent } from '../../store/tickets.js';
import { listInbox } from '../../store/ticketMessages.js';
import {
  DEFAULT_AUTOSTART_CAPS,
  makeSubtaskAutostart,
  type SubtaskAutostartDeps,
} from './subtaskAutostartOps.js';

let store: Store;
let projectId: number;
let parentId: number;

function child(key: string): number {
  return createTicket(store, {
    key,
    title: key,
    projectId,
    subtaskParentId: parentId,
    autostartPending: true,
  }).id;
}

function deps(over: Partial<SubtaskAutostartDeps> = {}): SubtaskAutostartDeps {
  return {
    store,
    projectId: () => projectId,
    caps: () => DEFAULT_AUTOSTART_CAPS,
    ownsParent: () => true,
    startTicket: vi.fn(async (id: number) => {
      setStageCurrent(store, id, 'impl');
      return { ok: true as const };
    }),
    notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) },
    debug: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  store = openStore(':memory:');
  projectId = upsertProject(store, { slug: 'p' }).id;
  parentId = createTicket(store, { key: 'P-1', title: 'parent', projectId }).id;
  setStageCurrent(store, parentId, 'impl');
});

describe('subtask autostart op', () => {
  it('defaults to 2 per parent / 4 total', () => {
    expect(DEFAULT_AUTOSTART_CAPS).toEqual({ perParent: 2, total: 4 });
  });

  it('claims and starts picked sub-tasks within the caps, without pulling base', async () => {
    const a = child('P-1-s1');
    const b = child('P-1-s2');
    const c = child('P-1-s3');
    const d = deps();
    const started = await makeSubtaskAutostart(d).sweep();
    expect(started).toEqual([a, b]);
    expect(d.startTicket).toHaveBeenCalledWith(a, { pullBase: false });
    expect(d.startTicket).toHaveBeenCalledTimes(2);
    expect(findTicketById(store, c)?.autostartPending).toBe(true);
    expect(findTicketById(store, a)?.autostartPending).toBe(false);
    expect(d.debug).toHaveBeenCalledWith(expect.stringContaining('[driver] autostart'));
  });

  it('does nothing without a bound project', async () => {
    child('P-1-s1');
    const d = deps({ projectId: () => undefined });
    expect(await makeSubtaskAutostart(d).sweep()).toEqual([]);
    expect(d.startTicket).not.toHaveBeenCalled();
  });

  it('only starts children of parents this window owns', async () => {
    child('P-1-s1');
    const d = deps({ ownsParent: () => false });
    expect(await makeSubtaskAutostart(d).sweep()).toEqual([]);
  });

  it('skips a child another window already claimed', async () => {
    const a = child('P-1-s1');
    store.db.prepare('UPDATE tickets SET autostart_pending = 0 WHERE id = ?').run(a);
    const d = deps();
    expect(await makeSubtaskAutostart(d).sweep()).toEqual([]);
  });

  it('a failure before the scope transition warns and posts an event saying it stayed at scope', async () => {
    const a = child('P-1-s1');
    const d = deps({ startTicket: vi.fn(async () => ({ ok: false as const, message: 'no repos' })) });
    expect(await makeSubtaskAutostart(d).sweep()).toEqual([]);
    expect(d.notify.warn).toHaveBeenCalledWith(expect.stringContaining('P-1-s1'));
    const [msg] = listInbox(store, parentId, { unreadOnly: false });
    expect(msg?.kind).toBe('event');
    expect(msg?.fromTicketId).toBeNull();
    expect(msg?.body).toContain('P-1-s1 autostart failed: no repos');
    expect(msg?.body).toContain('stayed at scope');
    expect(findTicketById(store, a)?.autostartPending).toBe(false);
  });

  it('a failure after the scope transition reports the child at impl without a session', async () => {
    child('P-1-s1');
    const d = deps({
      startTicket: vi.fn(async (id: number) => {
        setStageCurrent(store, id, 'impl');
        throw new Error('terminal spawn failed');
      }),
    });
    await makeSubtaskAutostart(d).sweep();
    const [msg] = listInbox(store, parentId, { unreadOnly: false });
    expect(msg?.body).toContain('terminal spawn failed');
    expect(msg?.body).toContain('at impl without a session');
  });

  it('bounds the failure reason to 300 characters', async () => {
    child('P-1-s1');
    const d = deps({ startTicket: vi.fn(async () => ({ ok: false as const, message: 'x'.repeat(1000) })) });
    await makeSubtaskAutostart(d).sweep();
    const [msg] = listInbox(store, parentId, { unreadOnly: false });
    expect(msg?.body).toContain('x'.repeat(300));
    expect(msg?.body).not.toContain('x'.repeat(301));
  });

  it('is re-entrancy guarded: an overlapping sweep starts nothing', async () => {
    child('P-1-s1');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps({
      startTicket: vi.fn(async () => {
        await gate;
        return { ok: true as const };
      }),
    });
    const op = makeSubtaskAutostart(d);
    const first = op.sweep();
    expect(await op.sweep()).toEqual([]);
    release();
    expect(await first).toHaveLength(1);
    expect(d.startTicket).toHaveBeenCalledTimes(1);
  });

  it('a throwing picker/store is caught, logged and warned', async () => {
    const d = deps({ caps: () => { throw new Error('boom'); } });
    expect(await makeSubtaskAutostart(d).sweep()).toEqual([]);
    expect(d.debug).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
