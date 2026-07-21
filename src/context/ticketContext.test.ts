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

  describe('merge checks', () => {
    function seedPr(id: number): void {
      store.db
        .prepare(
          "INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'frontend', 42, 'https://x/pr/42', 'open')",
        )
        .run(id);
    }

    function record(id: number, state: string, files: string[], reason: string | null): void {
      store.db
        .prepare(
          `INSERT INTO merge_checks (ticket_id, repo, state, files, reason, head_sha, base_sha, base_ref, checked_at)
           VALUES (?, 'frontend', ?, ?, ?, 'aaa', 'bbb', 'main', '2026-07-21T10:00:00.000Z')`,
        )
        .run(id, state, JSON.stringify(files), reason);
    }

    // A ticket shipped before merge checks existed must render byte-identically,
    // and its JSON must carry no new key — the CLI's consumers are agents.
    it('omits the merge suffix entirely when nothing was ever checked', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'x' });
      seedPr(t.id);
      const ctx = buildTicketContext(store, undefined, t.id);

      expect(ctx.prs[0]).not.toHaveProperty('mergeCheck');
      expect(renderTicketContext(ctx)).toContain('- frontend #42 [open] — https://x/pr/42');
      expect(renderTicketContext(ctx)).not.toContain('merge:');
    });

    it('renders a clean check on the PR line', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'x' });
      seedPr(t.id);
      record(t.id, 'clean', [], null);

      const md = renderTicketContext(buildTicketContext(store, undefined, t.id));

      expect(md).toContain('· merge: clean');
    });

    it('renders a conflict with the conflicting files', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'x' });
      seedPr(t.id);
      record(t.id, 'conflicted', ['src/a.ts', 'src/b.ts'], null);

      const md = renderTicketContext(buildTicketContext(store, undefined, t.id));

      expect(md).toContain('merge: conflicted (2 files: src/a.ts, src/b.ts)');
    });

    // An agent reading this must be able to tell "checked, fine" from "we do not
    // know", and must get git's own words to act on.
    it('renders an unknown check with git’s reason, never as clean', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'x' });
      seedPr(t.id);
      record(t.id, 'unknown', [], "fatal: couldn't find remote ref main");

      const md = renderTicketContext(buildTicketContext(store, undefined, t.id));

      expect(md).toContain("merge: unknown (fatal: couldn't find remote ref main)");
      expect(md).not.toContain('merge: clean');
    });
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
