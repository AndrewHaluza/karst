import { describe, expect, it } from 'vitest';
import { openStore } from './db.js';
import { migrate } from './migrations.js';
import {
  clearManualLink,
  listCloudSessionLinks,
  setManualLink,
  upsertCloudSessionLink,
} from './cloudSessionLinks.js';

const U = 'https://claude.ai/code/session_a';
const ref = { projectId: 1, provider: 'claude', url: U };

function setup() {
  const store = openStore(':memory:');
  store.db.prepare("INSERT INTO projects (id, slug) VALUES (1, 'p')").run();
  for (const id of [10, 11]) {
    store.db.prepare('INSERT INTO tickets (id, project_id, key) VALUES (?, 1, ?)').run(id, `K-${id}`);
  }
  store.db.prepare("INSERT INTO planning_sessions (id, project_id, title, core) VALUES (1, 1, 't', 'c')").run();
  store.db
    .prepare("INSERT INTO planning_proposals (id, session_id, payload_json) VALUES (5, 1, '{}')")
    .run();
  return store;
}
const list = (s: ReturnType<typeof setup>) => listCloudSessionLinks(s, { projectId: 1 });

describe('cloudSessionLinks store', () => {
  it('upserts a scan match and re-points it on a rescan', () => {
    const s = setup();
    upsertCloudSessionLink(s, ref, { ticketId: 10, source: 'pr' });
    upsertCloudSessionLink(s, ref, { ticketId: 11, source: 'branch' });
    expect(list(s)).toEqual([
      expect.objectContaining({ ticketId: 11, linkSource: 'branch', proposalId: null }),
    ]);
  });
  it('records an unmatched session as unlinked', () => {
    const s = setup();
    upsertCloudSessionLink(s, ref, null);
    expect(list(s)[0]).toMatchObject({ ticketId: null, linkSource: null });
  });
  it('never overwrites a manual row', () => {
    const s = setup();
    setManualLink(s, ref, { ticketId: 10 });
    upsertCloudSessionLink(s, ref, { ticketId: 11, source: 'pr' });
    upsertCloudSessionLink(s, ref, null);
    expect(list(s)[0]).toMatchObject({ ticketId: 10, linkSource: 'manual' });
  });
  it('clearManualLink keeps the row manual and unlinked across a rescan', () => {
    const s = setup();
    upsertCloudSessionLink(s, ref, { ticketId: 10, source: 'key' });
    clearManualLink(s, ref);
    upsertCloudSessionLink(s, ref, { ticketId: 10, source: 'key' });
    expect(list(s)).toHaveLength(1);
    expect(list(s)[0]).toMatchObject({ ticketId: null, linkSource: 'manual' });
  });
  it('clearManualLink on an unknown session inserts an unlinked manual row', () => {
    const s = setup();
    clearManualLink(s, ref);
    expect(list(s)[0]).toMatchObject({ ticketId: null, linkSource: 'manual' });
  });
  it('re-linking a manual row to another target replaces the old one', () => {
    const s = setup();
    setManualLink(s, ref, { proposalId: 5 });
    setManualLink(s, ref, { ticketId: 11 });
    expect(list(s)[0]).toMatchObject({ ticketId: 11, proposalId: null });
  });
  it('a pending draft link has a proposalId and no ticket', () => {
    const s = setup();
    setManualLink(s, ref, { proposalId: 5 });
    expect(list(s)[0]).toMatchObject({ ticketId: null, proposalId: 5 });
  });
  it('an accepted draft resolves to its new ticket with no copy', () => {
    const s = setup();
    setManualLink(s, ref, { proposalId: 5 });
    s.db.prepare("UPDATE planning_proposals SET status='accepted', ticket_id=11 WHERE id=5").run();
    expect(list(s)[0]).toMatchObject({ ticketId: 11, proposalId: null, linkSource: 'manual' });
  });
  it('a discarded draft makes the link unlinked', () => {
    const s = setup();
    setManualLink(s, ref, { proposalId: 5 });
    s.db.prepare("UPDATE planning_proposals SET status='discarded', ticket_id=11 WHERE id=5").run();
    expect(list(s)[0]).toMatchObject({ ticketId: null, proposalId: null });
  });
  it('scopes by project and cascades on ticket delete', () => {
    const s = setup();
    upsertCloudSessionLink(s, ref, { ticketId: 10, source: 'pr' });
    upsertCloudSessionLink(s, { ...ref, projectId: 2 }, null);
    expect(list(s)).toHaveLength(1);
    s.db.prepare('DELETE FROM tickets WHERE id=10').run();
    expect(list(s)).toHaveLength(0);
  });
  it('deleting a proposal leaves the link unlinked', () => {
    const s = setup();
    setManualLink(s, ref, { proposalId: 5 });
    s.db.prepare('DELETE FROM planning_proposals WHERE id=5').run();
    expect(list(s)[0]).toMatchObject({ ticketId: null, proposalId: null });
  });
});

describe('v90 migration', () => {
  it('adds the table to a v89 DB, idempotently', () => {
    const s = openStore(':memory:');
    s.db.exec('DROP TABLE cloud_session_links');
    s.db.pragma('user_version = 89');
    migrate(s.db);
    migrate(s.db);
    expect(s.db.prepare("SELECT name FROM sqlite_master WHERE name='cloud_session_links'").all()).toHaveLength(1);
  });
});
