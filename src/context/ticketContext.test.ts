import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, updateTicketOnboarding } from '../store/tickets.js';
import { buildTicketContext, renderTicketContext } from './ticketContext.js';
import type { Manifest, ServiceDef } from '../manifest/types.js';

function svc(over: Partial<ServiceDef> = {}): ServiceDef {
  return {
    repoPath: '/repos/frontend',
    start: 'npm run dev',
    ports: [{ name: 'port', env: 'PORT', default: 3000 }],
    dependsOn: [],
    hasMigrations: false,
    ...over,
  };
}

function manifest(services: Record<string, ServiceDef>): Manifest {
  return {
    host: 'localhost',
    portRange: [3000, 3999],
    baselineBranch: 'main',
    services,
  };
}

describe('buildTicketContext', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function seed(): number {
    const t = createTicket(store, { key: 'PROJ-9', title: 'Do research' });
    updateTicketOnboarding(store, t.id, {
      description: 'Audit the app',
      brief: 'A short brief',
      approach: 'rpi',
      selectedRepos: ['frontend'],
    });
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, 'frontend', '/wt/frontend', 'feat/x', 'main', 'inherited')",
      )
      .run(t.id);
    store.db
      .prepare(
        "INSERT INTO servers (ticket_id, service, host, port, status) VALUES (?, 'frontend', '127.0.0.1', 3001, 'running')",
      )
      .run(t.id);
    store.db
      .prepare(
        "INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'frontend', 42, 'https://x/pr/42', 'open')",
      )
      .run(t.id);
    return t.id;
  }

  it('aggregates ticket, worktrees, servers, prs, and named services', () => {
    const id = seed();
    const ctx = buildTicketContext(store, manifest({ frontend: svc(), backend: svc() }), id);

    expect(ctx.key).toBe('PROJ-9');
    expect(ctx.prompt).toBe('Audit the app');
    expect(ctx.brief).toBe('A short brief');
    expect(ctx.selectedRepos).toEqual(['frontend']);
    expect(ctx.worktrees).toEqual([
      { repo: 'frontend', path: '/wt/frontend', branch: 'feat/x', baseRef: 'main', depsMode: 'inherited' },
    ]);
    expect(ctx.servers).toEqual([
      { service: 'frontend', host: '127.0.0.1', port: 3001, status: 'running' },
    ]);
    expect(ctx.prs).toEqual([
      { repo: 'frontend', number: 42, url: 'https://x/pr/42', status: 'open' },
    ]);
    // Only services named in selectedRepos are included (not `backend`).
    expect(ctx.services.map((s) => s.name)).toEqual(['frontend']);
    expect(ctx.services[0]!.start).toBe('npm run dev');
  });

  it('tolerates a missing manifest (no services section)', () => {
    const id = seed();
    const ctx = buildTicketContext(store, undefined, id);
    expect(ctx.services).toEqual([]);
  });
});

describe('renderTicketContext', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('renders every populated section as markdown', () => {
    const t = createTicket(store, { key: 'PROJ-9', title: 'Do research' });
    updateTicketOnboarding(store, t.id, {
      description: 'Audit the app',
      brief: 'A short brief',
      selectedRepos: ['frontend'],
    });
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, 'frontend', '/wt/frontend', 'feat/x', 'main', 'inherited')",
      )
      .run(t.id);
    const md = renderTicketContext(
      buildTicketContext(store, manifest({ frontend: svc() }), t.id),
    );
    expect(md).toContain('# Ticket: PROJ-9 — Do research');
    expect(md).toContain('## Prompt\nAudit the app');
    expect(md).toContain('## Context brief\nA short brief');
    expect(md).toContain('## Worktrees & branches');
    expect(md).toContain('feat/x');
    expect(md).toContain('## Services');
  });

  it('omits empty sections and falls back to the heading for an empty ticket', () => {
    const t = createTicket(store, { key: '', title: '' });
    const ctx = buildTicketContext(store, undefined, t.id);
    const md = renderTicketContext(ctx);
    // Only a heading fallback, no data sections.
    expect(md).toBe('# Ticket: Untitled ticket');
    expect(md).not.toContain('## Prompt');
    expect(md).not.toContain('## Worktrees');
  });
});
