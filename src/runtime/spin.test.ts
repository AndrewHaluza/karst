import { describe, it, expect, beforeEach, vi } from 'vitest';
import { expandEnvTokens, allocationRanges, hotRepoPaths, mergeRanges, spinTicket } from './spin.js';
import { manifest, repo, runnableRepo, svc, httpSlot, dependsOn } from '../manifest/fixtures.js';
import { openStore } from '../store/db.js';
import { createWorktree } from './worktree.js';
import { startResolvedService } from './startService.js';

describe('expandEnvTokens', () => {
  const env = { PORT: '4001', HOST: '127.0.0.1' };

  it('expands ${VAR} braced tokens', () => {
    expect(expandEnvTokens('npm run dev -- --port ${PORT} --strictPort', env)).toBe(
      'npm run dev -- --port 4001 --strictPort',
    );
  });

  it('expands $VAR bare tokens', () => {
    expect(expandEnvTokens('serve --host $HOST --port $PORT', env)).toBe(
      'serve --host 127.0.0.1 --port 4001',
    );
  });

  it('leaves a token-free command untouched', () => {
    expect(expandEnvTokens('npm run dev', env)).toBe('npm run dev');
  });

  it('expands an unknown token to empty string (shell-like)', () => {
    expect(expandEnvTokens('run --x ${MISSING}', env)).toBe('run --x ');
  });
});

describe('allocationRanges', () => {
  it('is the manifest range when no service overrides it', () => {
    const m = manifest({ api: runnableRepo() }, { portRange: [4000, 4999] });
    expect(allocationRanges(m, ['api'])).toEqual([[4000, 4999]]);
  });

  it('adds each service override', () => {
    const m = manifest(
      {
        api: runnableRepo({ portRange: [5000, 5100] }),
        web: runnableRepo({ portRange: [6000, 6100] }),
      },
      { portRange: [4000, 4999] },
    );
    // [4000,4999] and [5000,5100] touch, so they describe one contiguous span
    // and are walked as one; [6000,6100] is genuinely separate.
    expect(allocationRanges(m, ['api', 'web'])).toEqual([
      [4000, 5100],
      [6000, 6100],
    ]);
  });

  it('names an identical window once, however many services share it', () => {
    // Two services of a monorepo repeating one override, plus an override that
    // simply restates the manifest range: probing the same window twice costs
    // the sweep's budget and logs the same ports twice.
    const m = manifest(
      {
        api: runnableRepo({ portRange: [5000, 5100] }),
        grpc: runnableRepo({ portRange: [5000, 5100] }),
        web: runnableRepo({ portRange: [4000, 4999] }),
      },
      { portRange: [4000, 4999] },
    );
    expect(allocationRanges(m, ['api', 'grpc', 'web'])).toEqual([[4000, 5100]]);
  });

  it('merges an override that overlaps the manifest range', () => {
    // The window is walked once, not once per description of it.
    const m = manifest(
      { api: runnableRepo({ portRange: [4500, 5100] }) },
      { portRange: [4000, 4999] },
    );
    expect(allocationRanges(m, ['api'])).toEqual([[4000, 5100]]);
  });

  it('merges an override contained entirely inside the manifest range', () => {
    const m = manifest(
      { api: runnableRepo({ portRange: [4100, 4200] }) },
      { portRange: [4000, 4999] },
    );
    expect(allocationRanges(m, ['api'])).toEqual([[4000, 4999]]);
  });

  it('ignores a repository that declares no service', () => {
    const m = manifest({ docs: repo() }, { portRange: [4000, 4999] });
    expect(allocationRanges(m, ['docs'])).toEqual([[4000, 4999]]);
  });
});

describe('hotRepoPaths', () => {
  it('dedups entries that share one checkout', () => {
    const m = manifest({
      api: runnableRepo({}, { repoPath: '/mono' }),
      web: runnableRepo({}, { repoPath: '/mono' }),
      docs: repo({ repoPath: '/docs' }),
    });
    expect(hotRepoPaths(m, ['api', 'web', 'docs'])).toEqual(['/mono', '/docs']);
  });

  it('skips a name the manifest does not declare', () => {
    const m = manifest({ api: runnableRepo({}, { repoPath: '/api' }) });
    expect(hotRepoPaths(m, ['api', 'ghost'])).toEqual(['/api']);
  });
});

describe('mergeRanges', () => {
  it('leaves disjoint windows alone, in ascending order', () => {
    expect(mergeRanges([[6000, 6100], [4000, 4999]])).toEqual([
      [4000, 4999],
      [6000, 6100],
    ]);
  });

  it('collapses identical windows to one', () => {
    expect(mergeRanges([[5000, 5100], [5000, 5100]])).toEqual([[5000, 5100]]);
  });

  it('merges overlapping windows into their union', () => {
    expect(mergeRanges([[4000, 4999], [4500, 5100]])).toEqual([[4000, 5100]]);
  });

  it('merges windows that merely touch', () => {
    expect(mergeRanges([[4000, 4099], [4100, 4199]])).toEqual([[4000, 4199]]);
  });

  it('keeps a window swallowed by a wider one out of the result', () => {
    expect(mergeRanges([[4000, 4999], [4100, 4200]])).toEqual([[4000, 4999]]);
  });

  it('passes an inverted range through rather than repairing a bad manifest', () => {
    // `portsIn` yields nothing for it; quietly flipping it would hide the typo.
    expect(mergeRanges([[4000, 4999], [5100, 5000]])).toEqual([
      [4000, 4999],
      [5100, 5000],
    ]);
  });

  it('is empty for no ranges', () => {
    expect(mergeRanges([])).toEqual([]);
  });
});

describe('spinTicket — multi-service repositories', () => {
  // A unit test: git, the port probe and the process spawner are all replaced,
  // so only the spin's own sequencing (one worktree per repo, services of one
  // repo sharing it, each started in its own cwd) is exercised.
  vi.mock('./worktree.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./worktree.js')>();
    return { ...actual, createWorktree: vi.fn(), removeWorktree: vi.fn() };
  });
  vi.mock('./preflight.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./preflight.js')>();
    return { ...actual, preflightSpin: vi.fn() };
  });
  vi.mock('./startService.js', () => ({ startResolvedService: vi.fn() }));

  const WT = '/worktrees/t1/mono';

  beforeEach(() => {
    vi.mocked(createWorktree).mockReset();
    vi.mocked(startResolvedService).mockReset();
    vi.mocked(createWorktree).mockReturnValue({
      ticketId: 1,
      repoPath: '/repos/mono',
      slug: 't1',
      path: WT,
      branch: 'karst/t1',
      baseRef: 'develop',
      depsMode: 'local',
      adopted: false,
    } as unknown as ReturnType<typeof createWorktree>);
    vi.mocked(startResolvedService).mockImplementation(async (args) => ({
      id: 1,
      ticketId: args.ticketId,
      service: args.name,
      host: 'localhost',
      port: args.resolved.services[args.name]!.ports.http!,
      pid: 100,
      status: 'running',
      logPath: '/logs/x.log',
      container: null,
    }) as unknown as Awaited<ReturnType<typeof startResolvedService>>);
  });

  it('creates one worktree for two services of one repo and starts each in its own cwd', async () => {
    const store = openStore(':memory:');
    try {
      store.db.prepare('INSERT INTO tickets (id, key, title) VALUES (1, ?, ?)').run('K-1', 'mono');
      const m = manifest(
        {
          mono: repo({
            repoPath: '/repos/mono',
            services: {
              api: svc({ cwd: 'apps/api', ports: [httpSlot(3000)] }),
              web: svc({ cwd: 'apps/web', ports: [httpSlot(5173)], dependsOn: [
                dependsOn('mono/api', 'http', [{ env: 'API_URL', template: 'http://{host}:{port}' }]),
              ] }),
            },
          }),
        },
        { portRange: [4000, 4999] },
      );

      await spinTicket(store, m, 1, ['mono'], { probeBusyPorts: async () => new Set() });

      expect(createWorktree).toHaveBeenCalledTimes(1);
      const calls = vi.mocked(startResolvedService).mock.calls.map((c) => c[0]);
      expect(calls.map((c) => c.name)).toEqual(['mono/api', 'mono/web']);
      expect(calls.map((c) => c.cwd)).toEqual([WT, WT]);
    } finally {
      store.close();
    }
  });
});
