import { describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setDisabledGates } from '../../store/ticketGates.js';
import { manifest, repo, svc } from '../../manifest/fixtures.js';
import type { GitRunner } from '../../integrations/git.js';
import { buildGateOptionsLoader } from './gateOptions.js';

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
    expect(await load(ticketId, new AbortController().signal)).toEqual({ uat: [], review: [] });
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
    expect(await load(ticketId, new AbortController().signal)).toEqual({ uat: [], review: [] });
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
    expect(await load(ticketId, new AbortController().signal)).toEqual({ uat: [], review: [] });
  });

  // NDL-65: `SupplementalLoaders.pushGateOptions` aborts the previous probe's
  // controller every time a newer one starts, intending to cancel it. Before
  // this, the signal only reached an `if (signal.aborted)` check AFTER both
  // plans resolved, so the superseded probe's `git fetch` children kept running
  // to their own budget and stacked. The loader must hand the caller's signal
  // down so the abort actually cancels the fetch.
  it('cancels in-flight fetches when the loader signal is superseded', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    const captured: (AbortSignal | undefined)[] = [];
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const git: GitRunner = async (args, _cwd, options) => {
      if (args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'fetch') {
        captured.push(options?.signal);
        started();
        return await new Promise((resolve) => {
          const signal = options?.signal;
          const abort = () => resolve({ exitCode: 1, stdout: '', stderr: 'aborted' });
          if (signal?.aborted) return abort();
          signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    const load = buildGateOptionsLoader({
      store,
      manifest: () => manifest({ api: repo({ repoPath: '/repo/api', service: svc() }) }),
      probe: () => ({ kind: 'ok', scripts: { test: 'vitest' } }),
      git,
    });

    const controller = new AbortController();
    const loading = load(ticketId, controller.signal);
    await fetching;
    controller.abort();

    expect(await loading).toEqual({ uat: [], review: [] });
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((signal) => signal?.aborted === true)).toBe(true);
    store.close();
  });
});
