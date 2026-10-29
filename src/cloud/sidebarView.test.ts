import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { setManualLink, upsertCloudSessionLink } from '../store/cloudSessionLinks.js';
import { cloudSessionsForSidebar } from './sidebarView.js';

const url = (n: string) => `https://claude.ai/code/session_${n}`;

describe('cloudSessionsForSidebar', () => {
  it('groups by resolved ticket and lists the rest as unlinked', () => {
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO projects (id, slug) VALUES (1, 'p')").run();
    store.db.prepare('INSERT INTO tickets (id, project_id) VALUES (10, 1), (11, 1)').run();
    store.db.prepare("INSERT INTO planning_sessions (id, project_id, title, core) VALUES (1, 1, 't', 'c')").run();
    store.db.prepare("INSERT INTO planning_proposals (id, session_id, payload_json, status, ticket_id) VALUES (5, 1, '{}', 'accepted', 11)").run();
    const r = (n: string) => ({ projectId: 1, provider: 'claude', url: url(n) });
    upsertCloudSessionLink(store, r('a'), { ticketId: 10, source: 'pr' });
    upsertCloudSessionLink(store, r('b'), { ticketId: 10, source: 'key' });
    store.db.prepare("UPDATE cloud_session_links SET first_seen = '2026-10-20 10:00:00' WHERE url = ?").run(url('a'));
    store.db.prepare("UPDATE cloud_session_links SET first_seen = '2026-10-21 10:00:00' WHERE url = ?").run(url('b'));
    setManualLink(store, r('c'), { proposalId: 5 });
    store.db.prepare("UPDATE cloud_session_links SET first_seen = '2026-10-22 10:00:00' WHERE url = ?").run(url('c'));
    upsertCloudSessionLink(store, r('d'), null);
    const v = cloudSessionsForSidebar(store, 1);
    const label = 'Claude Code on the web';
    expect(v.byTicketId).toEqual({
      10: [
        { provider: 'claude', label, url: url('b'), linkSource: 'key', firstSeen: '2026-10-21 10:00:00' },
        { provider: 'claude', label, url: url('a'), linkSource: 'pr', firstSeen: '2026-10-20 10:00:00' },
      ],
      11: [{ provider: 'claude', label, url: url('c'), linkSource: 'manual', firstSeen: '2026-10-22 10:00:00' }],
    });
    expect(v.unlinked).toEqual([
      { id: expect.any(Number), provider: 'claude', label, url: url('d'), proposalId: null },
    ]);
  });
  it('falls back to the provider id for an unregistered provider, and is empty for no rows', () => {
    const store = openStore(':memory:');
    expect(cloudSessionsForSidebar(store, 1)).toEqual({ byTicketId: {}, unlinked: [] });
    upsertCloudSessionLink(store, { projectId: 1, provider: 'zzz', url: 'u' }, null);
    expect(cloudSessionsForSidebar(store, 1).unlinked[0]?.label).toBe('zzz');
  });
});
