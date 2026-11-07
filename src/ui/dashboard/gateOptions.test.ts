import { vi, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setDisabledGates } from '../../store/ticketGates.js';
import { manifest, repo, svc } from '../../manifest/fixtures.js';
import type { GitRunner } from '../../integrations/git.js';
import { buildGateOptionsLoader } from './gateOptions.js';

// Fixture worktree paths are fake; stub the existence check (path-handling tests inject their own).
vi.mock('../../workflow/gates/pathExists.js', () => ({ worktreePathExists: () => true }));

// Every repo reports a change, so affected-set selection is not what is under
// test here — `gates/targets.test.ts` owns that. Mirrors review/targets.test.ts's
// own `changed` fake.
const changed: GitRunner = async (args) =>
  args[0] === 'status'
    ? { exitCode: 0, stdout: ' M src/a.ts\n', stderr: '' }
    : { exitCode: 0, stdout: '', stderr: '' };

function seedScopedTicket(store: Store, repoPath: string): number {
  const t = createTicket(store, { key: 'K-1', title: 'A ticket' });
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(t.id, repoPath, '/wt/api', 'karst/K-1', null);
  return t.id;
}

describe('buildGateOptionsLoader', () => {
  it('lists the gates a ticket would actually run, with their disabled flags', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    setDisabledGates(store, ticketId, 'uat', ['e2e']);
    const load = buildGateOptionsLoader({
      store,
      manifest: () => manifest({ api: repo({ repoPath: '/repo/api', service: svc() }) }),
      probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'pw', lint: 'eslint .' } }),
      git: changed,
    });
    const options = await load(ticketId, new AbortController().signal);
    expect(options.uat).toEqual([
      { name: 'test', disabled: false },
      { name: 'e2e', disabled: true },
    ]);
    expect(options.runOrder?.uat).toEqual([
      { name: 'test', repo: '/repo/api', disabled: false },
      { name: 'e2e', repo: '/repo/api', disabled: true },
    ]);
    expect(options.review.some((o) => o.name === 'lint')).toBe(true);
  });

  it('lists a disabled gate even though resolution removed it from the run list', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    setDisabledGates(store, ticketId, 'uat', ['test', 'e2e']);
    const load = buildGateOptionsLoader({
      store,
      manifest: () => manifest({ api: repo({ repoPath: '/repo/api', service: svc() }) }),
      probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'pw' } }),
      git: changed,
    });
    const options = await load(ticketId, new AbortController().signal);
    expect(options.uat.every((o) => o.disabled)).toBe(true);
    expect(options.uat).toHaveLength(2);
  });

  it('returns empty lists rather than throwing when no manifest is resolved', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    const load = buildGateOptionsLoader({ store, manifest: () => undefined });
    const empty = { uat: [], review: [], runOrder: { uat: [], review: [] } };
    expect(await load(ticketId, new AbortController().signal)).toEqual(empty);
  });

  it('returns empty lists when the repository cannot be probed', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    const load = buildGateOptionsLoader({
      store,
      manifest: () => manifest({ api: repo({ repoPath: '/repo/api', service: svc() }) }),
      probe: () => ({ kind: 'io-error', message: 'EACCES' }),
      git: changed,
    });
    const empty = { uat: [], review: [], runOrder: { uat: [], review: [] } };
    expect(await load(ticketId, new AbortController().signal)).toEqual(empty);
  });

  it('degrades to empty lists when git is unavailable rather than throwing', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    const failingGit: GitRunner = async () => {
      throw new Error('git not found');
    };
    const load = buildGateOptionsLoader({
      store,
      manifest: () => manifest({ api: repo({ repoPath: '/repo/api', service: svc() }) }),
      probe: () => ({ kind: 'ok', scripts: { test: 'vitest' } }),
      git: failingGit,
    });
    const empty = { uat: [], review: [], runOrder: { uat: [], review: [] } };
    expect(await load(ticketId, new AbortController().signal)).toEqual(empty);
  });

  // The dashboard read is display-only and runs on every push: it must never
  // spawn `git fetch`. It compares with the `origin/<ref>` refs already cloned.
  it('runs no git fetch and diffs against the cloned origin refs', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const load = buildGateOptionsLoader({
      store,
      manifest: () => manifest({ api: repo({ repoPath: '/repo/api', service: svc() }) }),
      probe: () => ({ kind: 'ok', scripts: { test: 'vitest' } }),
      git,
    });
    await load(ticketId, new AbortController().signal);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((a) => a[0] === 'fetch')).toBe(false);
    const diff = calls.find((a) => a[0] === 'diff');
    expect(diff?.[2]).toMatch(/^origin\/.+\.\.\.origin\/karst\/K-1$/);
    store.close();
  });
});
