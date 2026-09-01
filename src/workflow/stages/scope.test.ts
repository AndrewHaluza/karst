import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { httpSlot, manifest as buildManifest, runnableRepo } from '../../manifest/fixtures.js';
import { createTicketFlow } from './create.js';
import { scopeTicket, confirmScope } from './scope.js';
import { updateTicketFields } from '../../store/tickets.js';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function makeRepo(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-scope-'));
  writeFileSync(join(dir, 'index.js'), 'x\n');
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 't@k.local');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function manifestFor(frontendPath: string, backendPath: string): Manifest {
  return buildManifest(
    {
      frontend: runnableRepo({}, { repoPath: frontendPath }),
      backend: runnableRepo(
        { start: 'npm start', ports: [httpSlot(8000)] },
        { repoPath: backendPath, hasMigrations: true },
      ),
    },
    { portRange: [4000, 4100] },
  );
}

describe('scopeTicket (warnings)', () => {
  let store: Store;
  let fe: { path: string; cleanup: () => void };
  let be: { path: string; cleanup: () => void };
  let manifest: Manifest;

  beforeEach(() => {
    store = openStore(':memory:');
    fe = makeRepo();
    be = makeRepo();
    manifest = manifestFor(fe.path, be.path);
  });
  afterEach(() => {
    store.close();
    fe.cleanup();
    be.cleanup();
  });

  it('warns when a hot service declares migrations (not first-class under shared-DB)', () => {
    const { warnings } = scopeTicket(manifest, ['backend']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/backend/);
    expect(warnings[0]).toMatch(/migration/i);
  });

  it('frontend-only scope returns no warnings', () => {
    expect(scopeTicket(manifest, ['frontend']).warnings).toEqual([]);
  });

  it('rejects an unknown service in the hot set', () => {
    expect(() => scopeTicket(manifest, ['nope'])).toThrow();
  });

  it('confirmScope creates a worktree per hot repo off the baseline branch', async () => {
    const t = createTicketFlow(store, { key: 'PROJ-1', title: 't' });
    const records = await confirmScope(store, manifest, t.id, ['frontend', 'backend'], {
      pullBase: false,
    });
    expect(records).toHaveLength(2);
    for (const rec of records) {
      expect(existsSync(rec.path)).toBe(true);
      expect(rec.baseRef).toBe('develop');
    }
  });

  it('cuts the worktree from the ticket override, not the manifest default', async () => {
    git(fe.path, 'branch', 'epic/checkout');
    const t = createTicketFlow(store, { key: 'S-1', title: 'scoped' });
    updateTicketFields(store, t.id, { baseRefs: { frontend: 'epic/checkout' } });

    const records = await confirmScope(store, manifest, t.id, ['frontend'], { pullBase: false });

    expect(records[0]!.baseRef).toBe('epic/checkout');
  });

  it('confirmScope with a frontend-only set creates just one worktree', async () => {
    const t = createTicketFlow(store, { key: 'PROJ-2', title: 't' });
    const records = await confirmScope(store, manifest, t.id, ['frontend'], { pullBase: false });
    expect(records).toHaveLength(1);
    expect(records[0]!.repoPath).toBe(fe.path);
  });

  // Two repository ENTRIES sharing one repoPath (a monorepo with two runnable
  // processes) make a single worktree, not two — the worktree slug is
  // per-ticket, so both entries resolve to the same path/branch. Restores the
  // dedup 53314d6 added and b7f223d wrongly deleted.
  it('confirmScope dedupes two hot repositories sharing one repoPath into a single worktree', async () => {
    const shared = runnableRepo(
      { start: 'npm run api' },
      { repoPath: fe.path },
    );
    const sharedManifest = buildManifest(
      { api: shared, web: runnableRepo({ start: 'npm run web' }, { repoPath: fe.path }) },
      { portRange: [4000, 4100] },
    );
    const t = createTicketFlow(store, { key: 'PROJ-3', title: 't' });
    const records = await confirmScope(store, sharedManifest, t.id, ['api', 'web'], {
      pullBase: false,
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.repoPath).toBe(fe.path);
  });
});

/**
 * The pull switch (§ scope): a ticket's worktree is cut from the baseline
 * branch, so an un-refreshed local base starts every ticket behind the team.
 * Refreshing is the DEFAULT and the user's explicit choice is honored.
 *
 * Real git against a local bare "remote" — no network, and the fetch semantics
 * (a checked-out base refuses the fast-forward refspec) are the real ones a
 * faked runner would only assert about itself.
 */
describe('confirmScope (pull the base before branching)', () => {
  let store: Store;
  let origin: string;
  let repo: string;
  let manifest: Manifest;
  const dirs: string[] = [];

  const tmp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  beforeEach(() => {
    store = openStore(':memory:');

    origin = tmp('karst-origin-');
    git(origin, 'init', '-q', '--bare', '-b', 'develop');

    // The working clone: one commit, pushed. Its develop is checked out, which
    // is exactly what makes git refuse `fetch origin develop:develop` later.
    repo = tmp('karst-scope-pull-');
    writeFileSync(join(repo, 'index.js'), 'x\n');
    git(repo, 'init', '-q', '-b', 'develop');
    git(repo, 'config', 'user.email', 't@k.local');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'develop');

    // A teammate lands a commit the working clone has never seen.
    const other = tmp('karst-other-');
    git(other, 'clone', '-q', origin, other);
    git(other, 'config', 'user.email', 'o@k.local');
    git(other, 'config', 'user.name', 'o');
    writeFileSync(join(other, 'teammate.js'), 'newer\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'teammate work');
    git(other, 'push', '-q', 'origin', 'develop');

    manifest = buildManifest(
      { frontend: runnableRepo({}, { repoPath: repo }) },
      { portRange: [4000, 4100] },
    );
  });
  afterEach(() => {
    store.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('refreshes the base by default, so the worktree carries the remote commit', async () => {
    const t = createTicketFlow(store, { key: 'PULL-1', title: 't' });

    const records = await confirmScope(store, manifest, t.id, ['frontend']);

    expect(existsSync(join(records[0]!.path, 'teammate.js'))).toBe(true);
    // The RECORDED base stays the plain branch name whichever ref was branched
    // from — mergeCheck and the diff views re-derive `origin/<base>` themselves.
    expect(records[0]!.baseRef).toBe('develop');
  });

  it('honors an explicit opt-out: no fetch, worktree cut from the stale local base', async () => {
    const t = createTicketFlow(store, { key: 'PULL-2', title: 't' });

    const records = await confirmScope(store, manifest, t.id, ['frontend'], { pullBase: false });

    expect(existsSync(join(records[0]!.path, 'teammate.js'))).toBe(false);
  });

  it('reports a failed pull and still creates the worktree', async () => {
    git(repo, 'remote', 'remove', 'origin');
    const t = createTicketFlow(store, { key: 'PULL-3', title: 't' });
    const warnings: { repoPath: string; baseRef: string; reason: string }[] = [];

    const records = await confirmScope(store, manifest, t.id, ['frontend'], {
      onPullFailed: (repoPath, baseRef, reason) => warnings.push({ repoPath, baseRef, reason }),
    });

    expect(existsSync(records[0]!.path)).toBe(true); // creation is never blocked
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.repoPath).toBe(repo);
    expect(warnings[0]!.baseRef).toBe('develop');
    expect(warnings[0]!.reason).not.toBe('');
  });

  // Two entries at one repoPath share a worktree; they must also share ONE
  // fetch, not one per manifest entry.
  it('pulls once per repoPath, not once per repository entry', async () => {
    const shared = buildManifest(
      {
        api: runnableRepo({ start: 'npm run api' }, { repoPath: repo }),
        web: runnableRepo({ start: 'npm run web' }, { repoPath: repo }),
      },
      { portRange: [4000, 4100] },
    );
    const t = createTicketFlow(store, { key: 'PULL-4', title: 't' });
    let fetches = 0;

    const records = await confirmScope(store, shared, t.id, ['api', 'web'], {
      git: async (args, cwd) => {
        if (args[0] === 'fetch') fetches += 1;
        const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
      },
    });

    expect(records).toHaveLength(1);
    // The ff refspec is refused (develop is checked out), so exactly one repo
    // costs the two fetch attempts of `pullBaseRef` — never four.
    expect(fetches).toBe(2);
  });
});
