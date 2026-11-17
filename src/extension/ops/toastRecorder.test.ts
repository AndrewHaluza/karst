import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { listEvents } from '../../store/karstEvents.js';
import { makeToastRecorder, panelActionRecorder } from './toastRecorder.js';

describe('makeToastRecorder', () => {
  let store: Store;
  let projectId: number;
  const debug: string[] = [];
  beforeEach(() => {
    debug.length = 0;
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p1' }).id;
  });

  it('writes one host row with the level and the message as the title', () => {
    makeToastRecorder({ store, projectId: () => projectId, debug: (m) => debug.push(m) })('warn', 'Disk is full');
    const rows = listEvents(store, { projectId, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'warn', source: 'host', title: 'Disk is full', body: '', ticketId: null });
  });

  it('keeps a long or multi-line message whole in the body', () => {
    const record = makeToastRecorder({ store, projectId: () => projectId, debug: () => {} });
    record('error', 'line one\nline two');
    record('info', 'x'.repeat(200));
    const rows = listEvents(store, { projectId, limit: 10 });
    expect(rows.map((r) => r.body)).toEqual(['x'.repeat(200), 'line one\nline two']);
  });

  it('links the row to its ticket and uses the panel source on request', () => {
    const ticketId = (store.db.prepare(`INSERT INTO tickets (key, title, project_id) VALUES ('T-1', 't', ?)`).run(projectId).lastInsertRowid) as number;
    const record = makeToastRecorder({ store, projectId: () => projectId, debug: () => {} }, 'panel');
    panelActionRecorder(record)({ level: 'success', message: 'Archived', ticketId: Number(ticketId) });
    expect(listEvents(store, { projectId, limit: 1 })[0]).toMatchObject({ source: 'panel', level: 'success', ticketId: Number(ticketId) });
  });

  it('writes nothing while no project is bound', () => {
    makeToastRecorder({ store, projectId: () => undefined, debug: () => {} })('info', 'early');
    expect(listEvents(store, { projectId, limit: 10 })).toEqual([]);
  });

  it('logs a failed write and does not throw', () => {
    store.db.exec('DROP TABLE karst_events');
    expect(() => makeToastRecorder({ store, projectId: () => projectId, debug: (m) => debug.push(m) })('info', 'x')).not.toThrow();
    expect(debug[0]).toContain('karst event failed');
  });
});
