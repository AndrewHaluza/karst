import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { upsertProject } from './projects.js';
import {
  EVENT_BODY_MAX,
  EVENT_MAX_AGE_DAYS,
  EVENT_MAX_ROWS_PER_PROJECT,
  EVENT_TITLE_MAX,
  countEvents,
  getEvent,
  listEvents,
  markAllEventsRead,
  markEventRead,
  recordEvent,
  unreadEventCount,
} from './karstEvents.js';

describe('karstEvents', () => {
  let store: Store;
  let projectId: number;
  const debugLines: string[] = [];
  const debug = (m: string): void => { debugLines.push(m); };
  beforeEach(() => {
    debugLines.length = 0;
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p1' }).id;
  });
  afterEach(() => store.close());

  const base = () => ({ projectId, level: 'info' as const, source: 'autopilot' as const, title: 't' });

  it('records an event and lists it with its fields', () => {
    const t = createTicket(store, { key: 'EV-1', projectId, title: 'x' });
    const id = recordEvent(store, { ...base(), ticketId: t.id, level: 'warn', body: 'b' }, debug);
    expect(id).not.toBeNull();
    const [row] = listEvents(store, { projectId, limit: 10 });
    expect(row).toMatchObject({ id, projectId, ticketId: t.id, level: 'warn', source: 'autopilot', title: 't', body: 'b', readAt: null });
  });

  it('stores a null ticket id and an empty body by default', () => {
    recordEvent(store, base(), debug);
    expect(listEvents(store, { projectId, limit: 10 })[0]).toMatchObject({ ticketId: null, body: '' });
  });

  it('puts the title on one line, strips control characters and clips to the caps', () => {
    recordEvent(store, { ...base(), title: `a\n b\u0007${'x'.repeat(500)}`, body: 'y'.repeat(EVENT_BODY_MAX + 50) }, debug);
    const [row] = listEvents(store, { projectId, limit: 1 });
    expect(row!.title.includes('\n')).toBe(false);
    expect(row!.title.startsWith('a b')).toBe(true);
    expect(row!.title).toHaveLength(EVENT_TITLE_MAX);
    expect(row!.title.endsWith('…')).toBe(true);
    expect(row!.body).toHaveLength(EVENT_BODY_MAX);
  });

  it('never throws: a bad level is logged through debug and returns null', () => {
    const id = recordEvent(store, { ...base(), level: 'loud' as never }, debug);
    expect(id).toBeNull();
    expect(debugLines.join('\n')).toMatch(/karst event/);
    expect(listEvents(store, { projectId, limit: 10 })).toEqual([]);
  });

  it('lists newest first with a limit and a beforeId cursor', () => {
    const ids = [1, 2, 3].map((n) => recordEvent(store, { ...base(), title: `e${n}` }, debug)!);
    expect(listEvents(store, { projectId, limit: 2 }).map((e) => e.title)).toEqual(['e3', 'e2']);
    expect(listEvents(store, { projectId, limit: 5, beforeId: ids[2]! }).map((e) => e.title)).toEqual(['e2', 'e1']);
  });

  it('scopes events to the project', () => {
    const other = upsertProject(store, { slug: 'p2' }).id;
    recordEvent(store, { ...base(), projectId: other }, debug);
    expect(listEvents(store, { projectId, limit: 10 })).toEqual([]);
    expect(unreadEventCount(store, projectId)).toBe(0);
  });

  it('counts unread events and marks one or all read', () => {
    const a = recordEvent(store, base(), debug)!;
    recordEvent(store, base(), debug);
    expect(unreadEventCount(store, projectId)).toBe(2);
    markEventRead(store, a);
    expect(unreadEventCount(store, projectId)).toBe(1);
    markAllEventsRead(store, projectId);
    expect(unreadEventCount(store, projectId)).toBe(0);
    expect(listEvents(store, { projectId, limit: 10 }).every((e) => e.readAt !== null)).toBe(true);
  });

  it('markAllEventsRead leaves another project and keeps an earlier read_at', () => {
    const other = upsertProject(store, { slug: 'p2' }).id;
    const a = recordEvent(store, base(), debug)!;
    recordEvent(store, { ...base(), projectId: other }, debug);
    store.db.prepare("UPDATE karst_events SET read_at = '2020-01-01 00:00:00' WHERE id = ?").run(a);
    markAllEventsRead(store, projectId);
    markEventRead(store, a);
    expect(listEvents(store, { projectId, limit: 1 })[0]!.readAt).toBe('2020-01-01 00:00:00');
    expect(unreadEventCount(store, other)).toBe(1);
  });

  it('deletes this project\'s rows older than the age cap on the next record, and no other project\'s', () => {
    const other = upsertProject(store, { slug: 'p2' }).id;
    const old = recordEvent(store, { ...base(), title: 'old' }, debug)!;
    const otherOld = recordEvent(store, { ...base(), projectId: other, title: 'other-old' }, debug)!;
    const fresh = recordEvent(store, { ...base(), title: 'fresh' }, debug)!;
    const stamp = (id: number, days: number): void => {
      store.db.prepare(`UPDATE karst_events SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${days} days`, id);
    };
    stamp(old, EVENT_MAX_AGE_DAYS + 1);
    stamp(otherOld, EVENT_MAX_AGE_DAYS + 1);
    stamp(fresh, EVENT_MAX_AGE_DAYS - 1);
    recordEvent(store, { ...base(), title: 'new' }, debug);
    expect(listEvents(store, { projectId, limit: 10 }).map((e) => e.title)).toEqual(['new', 'fresh']);
    expect(listEvents(store, { projectId: other, limit: 10 }).map((e) => e.title)).toEqual(['other-old']);
  });

  it('keeps at most the row cap per project and deletes the oldest', () => {
    const other = upsertProject(store, { slug: 'p2' }).id;
    recordEvent(store, { ...base(), projectId: other }, debug);
    const ins = store.db.prepare("INSERT INTO karst_events (project_id, level, source, title) VALUES (?, 'info', 'host', ?)");
    store.db.transaction(() => {
      for (let i = 0; i < EVENT_MAX_ROWS_PER_PROJECT; i++) ins.run(projectId, `seed${i}`);
    })();
    recordEvent(store, { ...base(), title: 'last' }, debug);
    const n = (store.db.prepare('SELECT COUNT(*) AS n FROM karst_events WHERE project_id = ?').get(projectId) as { n: number }).n;
    expect(n).toBe(EVENT_MAX_ROWS_PER_PROJECT);
    const rows = listEvents(store, { projectId, limit: EVENT_MAX_ROWS_PER_PROJECT });
    expect(rows[0]!.title).toBe('last');
    expect(rows.some((e) => e.title === 'seed0')).toBe(false);
    expect(rows.some((e) => e.title === 'seed1')).toBe(true);
    expect(unreadEventCount(store, other)).toBe(1);
  });

  it('cascades when the ticket is deleted', () => {
    const t = createTicket(store, { key: 'EV-1', projectId, title: 'x' });
    recordEvent(store, { ...base(), ticketId: t.id }, debug);
    store.db.prepare('DELETE FROM tickets WHERE id = ?').run(t.id);
    expect(listEvents(store, { projectId, limit: 10 })).toEqual([]);
  });

  it('getEvent returns one row or null, and countEvents counts the project only', () => {
    const other = upsertProject(store, { slug: 'p2' }).id;
    const id = recordEvent(store, base(), debug)!;
    recordEvent(store, base(), debug);
    recordEvent(store, { ...base(), projectId: other }, debug);
    expect(getEvent(store, id)).toMatchObject({ id, projectId, title: 't' });
    expect(getEvent(store, 99999)).toBeNull();
    expect(countEvents(store, projectId)).toBe(2);
  });
});
