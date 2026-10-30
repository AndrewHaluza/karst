import { describe, expect, it } from 'vitest';
import { openStore } from './db.js';
import { migrate } from './migrations.js';
import {
  clearManualLink,
  listCloudSessionLinks,
  setManualLink,
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
  it('clearManualLink keeps the row manual and unlinked', () => {
    const s = setup();
    setManualLink(s, ref, { ticketId: 10 });
    clearManualLink(s, ref);
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
    setManualLink(s, ref, { ticketId: 10 });
    setManualLink(s, { ...ref, projectId: 2 }, { ticketId: 11 });
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

describe('v92 migration', () => {
  it('deletes scanned rows, keeps manual ones, idempotently', () => {
    const s = setup();
    const ins = s.db.prepare('INSERT INTO cloud_session_links (project_id, provider, url, ticket_id, link_source) VALUES (1, ?, ?, ?, ?)');
    ins.run('claude', 'u-pr', 10, 'pr');
    ins.run('claude', 'u-branch', 10, 'branch');
    ins.run('claude', 'u-key', 11, 'key');
    ins.run('claude', 'u-null', null, null);
    ins.run('claude', 'u-manual', 10, 'manual');
    ins.run('claude', 'u-manual-unlinked', null, 'manual');
    s.db.pragma('user_version = 91');
    migrate(s.db);
    migrate(s.db);
    expect(list(s).map((r) => r.url).sort()).toEqual(['u-manual', 'u-manual-unlinked']);
  });
});
