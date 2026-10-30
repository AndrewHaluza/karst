import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { listCloudSessionLinks } from '../../store/cloudSessionLinks.js';
import type { Notify } from './notify.js';
import { linkCloudSession, openCloudSession, unlinkCloudSession } from './cloudSessionLinkOps.js';

const U = 'https://claude.ai/code/session_m';

function setup() {
  const store = openStore(':memory:');
  store.db.prepare("INSERT INTO projects (id, slug) VALUES (1, 'p'), (2, 'q')").run();
  store.db.prepare("INSERT INTO tickets (id, project_id) VALUES (10, 1), (20, 2)").run();
  store.db.prepare("INSERT INTO planning_sessions (id, project_id, title, core) VALUES (1, 1, 't', 'c'), (2, 2, 't', 'c')").run();
  store.db
    .prepare("INSERT INTO planning_proposals (id, session_id, payload_json, status) VALUES (5, 1, '{}', 'pending'), (6, 1, '{}', 'discarded'), (7, 2, '{}', 'pending')")
    .run();
  const warns: string[] = [];
  const notify = { info() {}, warn: (m: string) => warns.push(m), error: async () => {} } as Notify;
  return { store, warns, deps: { store, notify, projectId: 1 } };
}
const rows = (s: ReturnType<typeof setup>) => listCloudSessionLinks(s.store, { projectId: 1 });

describe('linkCloudSession', () => {
  it('links to a project ticket; a second link of the same provider adds a second row', () => {
    const s = setup();
    expect(linkCloudSession(s.deps, U, { ticketId: 10 })).toBe(true);
    expect(linkCloudSession(s.deps, `${U}2`, { ticketId: 10 })).toBe(true);
    expect(rows(s)).toHaveLength(2);
    s.store.db.prepare('DELETE FROM cloud_session_links WHERE url = ?').run(`${U}2`);
    expect(rows(s)).toMatchObject([{ ticketId: 10, linkSource: 'manual', provider: 'claude' }]);
  });
  it('links to a live draft proposal', () => {
    const s = setup();
    expect(linkCloudSession(s.deps, U, { proposalId: 5 })).toBe(true);
    expect(rows(s)[0]).toMatchObject({ ticketId: null, proposalId: 5 });
  });
  it.each([
    [{ ticketId: 20 }],
    [{ ticketId: 99 }],
    [{ proposalId: 6 }],
    [{ proposalId: 7 }],
    [{ proposalId: 99 }],
  ])('refuses target %j', (target) => {
    const s = setup();
    expect(linkCloudSession(s.deps, U, target)).toBe(false);
    expect(rows(s)).toEqual([]);
    expect(s.warns).toEqual(['That ticket or draft is not available in this project.']);
  });
  it.each(['http://claude.ai/code/session_m', 'https://evil.example/code/session_m', `${U}/x`, 'junk'])(
    'refuses url %s',
    (url) => {
      const s = setup();
      expect(linkCloudSession(s.deps, url, { ticketId: 10 })).toBe(false);
      expect(rows(s)).toEqual([]);
      expect(s.warns).toEqual(['Not a recognised cloud session URL.']);
    },
  );
});

describe('unlinkCloudSession', () => {
  it('unlinks, keeping a manual unlinked row', () => {
    const s = setup();
    linkCloudSession(s.deps, U, { ticketId: 10 });
    expect(unlinkCloudSession(s.deps, U)).toBe(true);
    expect(rows(s)[0]).toMatchObject({ ticketId: null, linkSource: 'manual' });
  });
  it('refuses a bad url', () => {
    const s = setup();
    expect(unlinkCloudSession(s.deps, 'nope')).toBe(false);
    expect(s.warns).toHaveLength(1);
  });
});

describe('openCloudSession', () => {
  it('opens only recognised urls', async () => {
    const opened: string[] = [];
    const warns: string[] = [];
    const deps = {
      notify: { info() {}, warn: (m: string) => warns.push(m), error: async () => {} } as Notify,
      openExternal: async (u: string) => (opened.push(u), true),
    };
    expect(await openCloudSession(deps, U)).toBe(true);
    expect(await openCloudSession(deps, 'https://evil.example/x')).toBe(false);
    expect(opened).toEqual([U]);
    expect(warns).toHaveLength(1);
  });
});
