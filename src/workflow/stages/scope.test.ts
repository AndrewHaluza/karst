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

  it('confirmScope creates a worktree per hot repo off the baseline branch', () => {
    const t = createTicketFlow(store, { key: 'PROJ-1', title: 't' });
    const records = confirmScope(store, manifest, t.id, ['frontend', 'backend']);
    expect(records).toHaveLength(2);
    for (const rec of records) {
      expect(existsSync(rec.path)).toBe(true);
      expect(rec.baseRef).toBe('develop');
    }
  });

  it('confirmScope with a frontend-only set creates just one worktree', () => {
    const t = createTicketFlow(store, { key: 'PROJ-2', title: 't' });
    const records = confirmScope(store, manifest, t.id, ['frontend']);
    expect(records).toHaveLength(1);
    expect(records[0]!.repoPath).toBe(fe.path);
  });

  // Two repository ENTRIES sharing one repoPath (a monorepo with two runnable
  // processes) make a single worktree, not two — the worktree slug is
  // per-ticket, so both entries resolve to the same path/branch. Restores the
  // dedup 53314d6 added and b7f223d wrongly deleted.
  it('confirmScope dedupes two hot repositories sharing one repoPath into a single worktree', () => {
    const shared = runnableRepo(
      { start: 'npm run api' },
      { repoPath: fe.path },
    );
    const sharedManifest = buildManifest(
      { api: shared, web: runnableRepo({ start: 'npm run web' }, { repoPath: fe.path }) },
      { portRange: [4000, 4100] },
    );
    const t = createTicketFlow(store, { key: 'PROJ-3', title: 't' });
    const records = confirmScope(store, sharedManifest, t.id, ['api', 'web']);
    expect(records).toHaveLength(1);
    expect(records[0]!.repoPath).toBe(fe.path);
  });
});
