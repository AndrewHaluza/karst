import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { setManualLink, upsertCloudSessionLink } from '../../store/cloudSessionLinks.js';
import { buildSidebarState } from './state.js';

const url = (n: string) => `https://claude.ai/code/session_${n}`;

describe('buildSidebarState cloud sessions', () => {
  let store: Store;
  let projectId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p', name: 'p' }).id;
  });
  afterEach(() => store.close());
  const ref = (n: string) => ({ projectId, provider: 'claude', url: url(n) });

  it('puts a ticket sessions on its row and omits the field when it has none', () => {
    const a = createTicket(store, { key: 'A-1', title: 'a', projectId });
    createTicket(store, { key: 'B-1', title: 'b', projectId });
    upsertCloudSessionLink(store, ref('x'), { ticketId: a.id, source: 'pr' });
    const rows = buildSidebarState(store, { facets: ['all'], filter: '', projectId }).sections.current;
    const [withIt, without] = [rows.find((r) => r.ticketId === a.id)!, rows.find((r) => r.ticketId !== a.id)!];
    expect(withIt.cloudSessions).toEqual([
      { provider: 'claude', label: 'Claude Code on the web', url: url('x'), linkSource: 'pr', firstSeen: expect.any(String) },
    ]);
    expect('cloudSessions' in without).toBe(false);
  });

  it('lists unlinked sessions top-level, with the draft label when hung on a draft', () => {
    upsertCloudSessionLink(store, ref('free'), null);
    store.db.prepare("INSERT INTO planning_sessions (id, project_id, title, core) VALUES (1, ?, 't', 'c')").run(projectId);
    store.db.prepare("INSERT INTO planning_proposals (id, session_id, payload_json, status) VALUES (5, 1, '{\"title\":\"d\"}', 'pending')").run();
    setManualLink(store, ref('onDraft'), { proposalId: 5 });
    const s = buildSidebarState(store, { facets: ['all'], filter: '', projectId });
    expect(s.unlinkedCloudSessions.map((u) => [u.url, u.proposalId, u.proposalLabel])).toEqual([
      [url('free'), null, undefined],
      [url('onDraft'), 5, 'D5'],
    ]);
  });

  it('is empty without a project, and the search filter hides non-matching unlinked rows', () => {
    upsertCloudSessionLink(store, ref('abc'), null);
    expect(buildSidebarState(store, { facets: ['all'], filter: '' }).unlinkedCloudSessions).toEqual([]);
    const hit = buildSidebarState(store, { facets: ['all'], filter: 'SESSION_ABC', projectId });
    expect(hit.unlinkedCloudSessions).toHaveLength(1);
    const miss = buildSidebarState(store, { facets: ['all'], filter: 'zzz', projectId });
    expect(miss.unlinkedCloudSessions).toEqual([]);
    const label = buildSidebarState(store, { facets: ['all'], filter: 'code on the web', projectId });
    expect(label.unlinkedCloudSessions).toHaveLength(1);
  });
});
