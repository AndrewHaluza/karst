import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../../manifest/types.js';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket, findTicketById, setStageCurrent } from '../../store/tickets.js';
import { listInbox } from '../../store/ticketMessages.js';
import {
  autostartCapsFrom,
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
    caps: () => autostartCapsFrom(undefined),
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
  it('defaults to 2 per parent / 4 total when there is no manifest or no subtasks block', () => {
    expect(autostartCapsFrom(undefined)).toEqual({ perParent: 2, total: 4 });
    expect(autostartCapsFrom({} as Manifest)).toEqual({ perParent: 2, total: 4 });
  });

  it('reads the caps from the manifest, keeping 0 (unlimited)', () => {
    const m = { subtasks: { maxConcurrentPerParent: 0, maxConcurrentTotal: 7 } } as Manifest;
    expect(autostartCapsFrom(m)).toEqual({ perParent: 0, total: 7 });
  });

  it('re-reads the caps on every sweep', async () => {
    child('P-1-s1');
    child('P-1-s2');
    child('P-1-s3');
    let manifest: Manifest | undefined = { subtasks: { maxConcurrentPerParent: 1, maxConcurrentTotal: 4 } } as Manifest;
    const d = deps({ caps: () => autostartCapsFrom(manifest) });
    const op = makeSubtaskAutostart(d);
    expect(await op.sweep()).toHaveLength(1);
    manifest = { subtasks: { maxConcurrentPerParent: 0, maxConcurrentTotal: 0 } } as Manifest;
    expect(await op.sweep()).toHaveLength(2);
  });

  it('claims and starts picked sub-tasks within the caps, without pulling base', async () => {
    const a = child('P-1-s1');
    const b = child('P-1-s2');
    const c = child('P-1-s3');
    const d = deps();
    const started = await makeSubtaskAutostart(d).sweep();
    expect(started).toEqual([a, b]);
    expect(d.startTicket).toHaveBeenCalledWith(a, { pullBase: false, quiet: true });
    expect(d.startTicket).toHaveBeenCalledTimes(2);
    expect(findTicketById(store, c)?.autostartPending).toBe(true);
    expect(findTicketById(store, a)?.autostartStarting).toBe(true);
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
    store.db.prepare('UPDATE tickets SET autostart_pending = 2, autostart_claimed_at = datetime(\'now\') WHERE id = ?').run(a);
    const d = deps();
    expect(await makeSubtaskAutostart(d).sweep()).toEqual([]);
    expect(d.startTicket).not.toHaveBeenCalled();
  });

  it('re-queues an orphaned claim older than 10 minutes and starts it', async () => {
    const a = child('P-1-s1');
    store.db
      .prepare("UPDATE tickets SET autostart_pending = 2, autostart_claimed_at = datetime('now', '-11 minutes') WHERE id = ?")
      .run(a);
    const d = deps();
    expect(await makeSubtaskAutostart(d).sweep()).toEqual([a]);
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
    const after = findTicketById(store, a);
    expect(after?.autostartPending).toBe(false);
    expect(after?.autostartStarting).toBe(false);
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

  it('a throwing caps getter is caught and logged, never thrown', async () => {
    const d = deps({ caps: () => { throw new Error('boom'); } });
    expect(await makeSubtaskAutostart(d).sweep()).toEqual([]);
    expect(d.debug).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('the failure warning names the sub-task key', async () => {
    child('P-1-s1');
    const d = deps({ startTicket: vi.fn(async () => ({ ok: false as const, message: 'nope' })) });
    await makeSubtaskAutostart(d).sweep();
    expect(d.notify.warn).toHaveBeenCalledTimes(1);
    expect(d.notify.warn).toHaveBeenCalledWith(expect.stringMatching(/P-1-s1.*nope/));
  });

  it('dispose mid-sweep starts nothing further', async () => {
    child('P-1-s1');
    child('P-1-s2');
    const op = makeSubtaskAutostart(
      deps({
        startTicket: vi.fn(async (id: number) => {
          op.dispose();
          setStageCurrent(store, id, 'impl');
          return { ok: true as const };
        }),
      }),
    );
    expect(await op.sweep()).toEqual([expect.any(Number)]);
    expect(await op.sweep()).toEqual([]);
  });
});
