import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket } from '../../store/tickets.js';
import { markEventRead, recordEvent } from '../../store/karstEvents.js';
import { ACTIVITY_PAGE, EMPTY_ACTIVITY, buildActivity, eventIso } from './activity.js';

describe('buildActivity', () => {
  let store: Store;
  let projectId: number;
  const debug = (): void => undefined;
  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p1' }).id;
  });
  afterEach(() => store.close());
  const add = (title: string, ticketId?: number) =>
    recordEvent(store, { projectId, level: 'warn', source: 'host', title, ...(ticketId === undefined ? {} : { ticketId }) }, debug)!;

  it('is empty without a project', () => {
    expect(buildActivity(store, undefined)).toEqual(EMPTY_ACTIVITY);
  });

  it('lists newest first with the ticket label, unread flag and counts', () => {
    const t = createTicket(store, { key: 'A-1', projectId, title: 'x' });
    const first = add('one');
    const second = add('two', t.id);
    markEventRead(store, first);
    const view = buildActivity(store, projectId);
    expect(view.rows.map((r) => r.id)).toEqual([second, first]);
    expect(view.rows[0]).toMatchObject({ title: 'two', level: 'warn', ticketId: t.id, ticketLabel: `T${t.id}`, unread: true });
    expect(view.rows[1]).toMatchObject({ ticketId: null, ticketLabel: null, unread: false });
    expect(view).toMatchObject({ unread: 1, total: 2, hasMore: false });
  });

  it('caps the rows at the limit and reports more', () => {
    for (let i = 0; i < ACTIVITY_PAGE + 3; i++) add(`e${i}`);
    const view = buildActivity(store, projectId);
    expect(view.rows).toHaveLength(ACTIVITY_PAGE);
    expect(view).toMatchObject({ total: ACTIVITY_PAGE + 3, unread: ACTIVITY_PAGE + 3, hasMore: true });
    expect(buildActivity(store, projectId, ACTIVITY_PAGE * 2).hasMore).toBe(false);
  });

  it('does not list another project', () => {
    const other = upsertProject(store, { slug: 'p2' }).id;
    recordEvent(store, { projectId: other, level: 'info', source: 'host', title: 'x' }, debug);
    expect(buildActivity(store, projectId).total).toBe(0);
  });
});

describe('eventIso', () => {
  it('reads a SQLite UTC time as an ISO instant', () => {
    expect(eventIso('2026-11-19 08:05:00')).toBe('2026-11-19T08:05:00Z');
  });
  it('keeps a time that already has a zone', () => {
    expect(eventIso('2026-11-19T08:05:00Z')).toBe('2026-11-19T08:05:00Z');
    expect(eventIso('2026-11-19T08:05:00+02:00')).toBe('2026-11-19T08:05:00+02:00');
  });
});
