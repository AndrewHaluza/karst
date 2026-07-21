import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, updateTicketOnboarding } from '../store/tickets.js';
import { buildTicketContext, renderTicketContext } from './ticketContext.js';
import type { Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';
import {
  manifest as buildManifest,
  repo as buildRepo,
  runnableRepo,
  slot,
} from '../manifest/fixtures.js';

/** A runnable repository — the default most of these cases want. */
function svc(over: Partial<ServiceDef> = {}): RepositoryDef {
  return runnableRepo({ ports: [slot('port', 'PORT', 3000)], ...over }, {
    repoPath: '/repos/frontend',
  });
}

/** A repository with no service — never runnable, no port. */
function nonRunnable(repoPath = '/repos/docs'): RepositoryDef {
  return buildRepo({ repoPath });
}

function manifest(repos: Record<string, RepositoryDef>): Manifest {
  return buildManifest(repos, { portRange: [3000, 3999], baselineBranch: 'main' });
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
        "INSERT INTO servers (ticket_id, repo, host, port, status) VALUES (?, 'frontend', '127.0.0.1', 3001, 'running')",
      )
      .run(t.id);
    store.db
      .prepare(
        "INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'frontend', 42, 'https://x/pr/42', 'open')",
      )
      .run(t.id);
    return t.id;
  }

  it('aggregates ticket, worktrees, servers, prs, and named repositories', () => {
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
    // Only repositories named in selectedRepos are included (not `backend`).
    expect(ctx.repos.map((r) => r.name)).toEqual(['frontend']);
    expect(ctx.repos[0]!.start).toBe('npm run dev');
  });

  it('marks every selected repo unknown when there is no manifest', () => {
    const id = seed();
    const ctx = buildTicketContext(store, undefined, id);
    expect(ctx.repos).toEqual([{ name: 'frontend', runnable: false, unknown: true }]);
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
    expect(md).toContain('## Repositories in scope');
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

  // A non-runnable repo used to render `start: undefined` into the agent's brief.
  it('renders a repository with no service without inventing a start command', () => {
    const t = createTicket(store, { key: 'P-1', title: 'x' });
    updateTicketOnboarding(store, t.id, { selectedRepos: ['docs'] });
    const md = renderTicketContext(
      buildTicketContext(store, manifest({ docs: nonRunnable() }), t.id),
    );

    expect(md).toContain('- docs: /repos/docs (no service — not runnable)');
    expect(md).not.toContain('undefined');
    expect(md).not.toContain('start:');
  });

  // Previously `if (!def) continue` dropped it, telling the agent the repo did
  // not exist rather than that karst could not find it.
  it('says so when a selected repo is missing from the manifest, never dropping it', () => {
    const t = createTicket(store, { key: 'P-2', title: 'x' });
    updateTicketOnboarding(store, t.id, { selectedRepos: ['ghost'] });
    const md = renderTicketContext(
      buildTicketContext(store, manifest({ docs: nonRunnable() }), t.id),
    );

    expect(md).toContain('- ghost: (not in karst.yml)');
  });

  it('renders runnable and non-runnable repos in one section, not two', () => {
    const t = createTicket(store, { key: 'P-3', title: 'x' });
    updateTicketOnboarding(store, t.id, { selectedRepos: ['frontend', 'docs'] });
    const md = renderTicketContext(
      buildTicketContext(store, manifest({ frontend: svc(), docs: nonRunnable() }), t.id),
    );

    expect(md.match(/## Repositories in scope/g)).toHaveLength(1);
    expect(md).not.toContain('## Services');
    expect(md).toContain('- frontend: /repos/frontend (start: `npm run dev`)');
    expect(md).toContain('- docs: /repos/docs (no service — not runnable)');
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
