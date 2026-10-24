import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { archiveTicket, createTicket } from './tickets.js';
import { manifest, repo, runnableRepo, svc } from '../manifest/fixtures.js';
import { listSharedServersByTicket, type SharedServerView } from './sharedServers.js';

function addRef(store: Store, ticketId: number, key: string): void {
  store.db
    .prepare('INSERT OR IGNORE INTO baseline_refs (ticket_id, repo) VALUES (?, ?)')
    .run(ticketId, key);
}

function addBaseline(
  store: Store,
  key: string,
  over: { status?: string; host?: string | null; port?: number | null; logPath?: string | null } = {},
): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, started_at, cwd, container)
       VALUES (NULL, ?, ?, ?, 4242, ?, ?, '2026-08-12T10:00:00.000Z', '/tmp/baseline', 'karst-baseline-api')`,
    )
    .run(
      key,
      over.host === undefined ? 'localhost' : over.host,
      over.port === undefined ? 4000 : over.port,
      over.status ?? 'running',
      over.logPath === undefined ? `/tmp/${key.replace('/', '-')}.log` : over.logPath,
    );
  return Number(info.lastInsertRowid);
}

/** `api` shorthand + `web/ui` service-map entry, both runnable. */
function twoRepoManifest() {
  return manifest({
    api: runnableRepo({}, { repoPath: '/repos/api', baselineBranch: 'develop' }),
    web: repo({ repoPath: '/repos/web', services: { ui: svc() } }),
  });
}

function view(views: SharedServerView[], service: string): SharedServerView {
  const found = views.find((v) => v.service === service);
  if (!found) throw new Error(`no shared view for ${service}`);
  return found;
}

describe('listSharedServersByTicket', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns the baseline row a ref points at, with its address and log', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    const id = addBaseline(store, 'api');

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api')).toMatchObject({
      id,
      service: 'api',
      status: 'running',
      host: 'localhost',
      port: 4000,
      logPath: '/tmp/api.log',
      container: 'karst-baseline-api',
    });
  });

  it('resolves the base branch, baseline checkout and the repo/service display key', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'web/ui');
    addBaseline(store, 'web/ui');

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'web/ui')).toMatchObject({
      service: 'web/ui',
      status: 'running',
      baseBranch: 'develop',
      // ONE checkout per REPOSITORY, shared by its sibling services.
      checkoutPath: '/repos/web/.karst/baseline/web',
    });
  });

  it('reports a ref with no servers row as missing, without inventing an address', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api')).toMatchObject({
      id: null,
      status: 'missing',
      host: null,
      port: null,
      logPath: null,
      baseBranch: 'develop',
      missingReason: null,
    });
  });

  it('marks a unit that left the manifest missing, with the manifest reason, and never throws', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api/v2');
    addBaseline(store, 'api/v2');
    const shrunk = manifest({ web: runnableRepo({}, { repoPath: '/repos/web' }) });

    expect(view(listSharedServersByTicket(store, shrunk, t.id), 'api/v2')).toMatchObject({
      status: 'missing',
      baseBranch: null,
      checkoutPath: null,
      missingReason: 'no longer declared in karst.yml',
    });
  });

  it('keeps a stopped baseline visible as stopped, addressless', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    addBaseline(store, 'api', { status: 'stopped', host: null, port: null });

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api')).toMatchObject({
      status: 'stopped',
      host: null,
      port: null,
    });
  });

  it('passes a failed baseline through as failed', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    addBaseline(store, 'api', { status: 'failed', host: null, port: null });

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api').status).toBe(
      'failed',
    );
  });

  it('prefers the running row when a retired stopped row still exists', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    addBaseline(store, 'api', { status: 'stopped', port: null });
    const live = addBaseline(store, 'api');

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api')).toMatchObject({
      id: live,
      status: 'running',
    });
  });

  it('names the OTHER live dependents, excluding this ticket and finished or archived ones', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    const other = createTicket(store, { key: 'T-412', title: 'other' });
    const done = createTicket(store, { key: 'T-418', title: 'done' });
    const gone = createTicket(store, { key: 'T-419', title: 'archived' });
    for (const id of [t.id, other.id, done.id, gone.id]) addRef(store, id, 'api');
    // done + still running: it counts.
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(done.id);
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status)
         VALUES (?, 'web', 'localhost', 5173, 9, 'running')`,
      )
      .run(done.id);
    archiveTicket(store, gone.id);
    addBaseline(store, 'api');

    expect(
      view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api').sharedWith,
    ).toBe('shared with T-412, T-418');
  });

  it('falls back to T<id> for a dependent with no key', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    const other = createTicket(store, { key: 'T-412', title: 'other' });
    store.db.prepare('UPDATE tickets SET key = NULL WHERE id = ?').run(other.id);
    addRef(store, t.id, 'api');
    addRef(store, other.id, 'api');
    addBaseline(store, 'api');

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api').sharedWith).toBe(
      `shared with T${other.id}`,
    );
  });

  it('says "no other live tickets" when nothing else consumes the baseline', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    addBaseline(store, 'api');

    expect(
      view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api').sharedWith,
    ).toBe('no other live tickets');
  });

  it("returns [] for a ticket with no refs, and reports the ref's dependents", () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    addBaseline(store, 'api');

    expect(listSharedServersByTicket(store, twoRepoManifest(), t.id)[0]!.dependents).toHaveLength(1);
    expect(listSharedServersByTicket(store, twoRepoManifest(), 9999)).toEqual([]);
  });

  it('does not treat a ticket-scoped server row as the shared copy', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status)
         VALUES (?, 'api', 'localhost', 5173, 3, 'running')`,
      )
      .run(t.id);

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api').status).toBe(
      'missing',
    );
  });
});
