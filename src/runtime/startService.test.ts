import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { startHot } from './supervisor.js';
import { startResolvedService } from './startService.js';
import type { ResolveResult } from '../resolver/resolve.js';
import { httpSlot, manifest, repo, runnableRepo, slot } from '../manifest/fixtures.js';

vi.mock('./supervisor.js', () => ({ startHot: vi.fn() }));

const startHotMock = vi.mocked(startHot);

describe('startResolvedService', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
    startHotMock.mockReset();
    startHotMock.mockImplementation(async (_store, opts) => ({
      id: 1,
      ticketId: opts.ticketId,
      service: opts.service,
      host: opts.host,
      port: opts.port,
      pid: 4242,
      status: 'running',
      logPath: opts.logPath,
      container: opts.container ?? null,
    }));
  });

  afterEach(() => {
    store.close();
  });

  function resolvedFor(
    name: string,
    ports: Record<string, number>,
    env: Record<string, string> = {},
  ): ResolveResult {
    return {
      services: { [name]: { mode: 'hot', ports, env, baselineDeps: [] } },
      nonRunnable: [],
      startOrder: [name],
    };
  }

  it('starts with the resolved port for the service http slot', async () => {
    const m = manifest({ api: runnableRepo({ ports: [httpSlot(3000)] }) });
    const resolved = resolvedFor('api', { http: 4123 }, { PORT: '4123' });

    await startResolvedService({
      store,
      manifest: m,
      ticketId: 7,
      name: 'api',
      resolved,
      cwd: '/wt/api',
      envOverrides: {},
    });

    expect(startHotMock).toHaveBeenCalledOnce();
    const opts = startHotMock.mock.calls[0]![1];
    expect(opts.service).toBe('api');
    expect(opts.port).toBe(4123);
  });

  it('falls back to service.ports[0] when no slot is named http', async () => {
    const m = manifest({ api: runnableRepo({ ports: [slot('web', 'WEB_PORT', 3000)] }) });
    const resolved = resolvedFor('api', { web: 4222 }, { WEB_PORT: '4222' });

    await startResolvedService({
      store,
      manifest: m,
      ticketId: 7,
      name: 'api',
      resolved,
      cwd: '/wt/api',
      envOverrides: {},
    });

    const opts = startHotMock.mock.calls[0]![1];
    expect(opts.port).toBe(4222);
  });

  it('throws for a repository with no service', async () => {
    const m = manifest({ docs: repo() });

    await expect(
      startResolvedService({
        store,
        manifest: m,
        ticketId: 7,
        name: 'docs',
        resolved: { services: {}, nonRunnable: ['docs'], startOrder: [] },
        cwd: '/wt/docs',
        envOverrides: {},
      }),
    ).rejects.toThrow('repository "docs" declares no service');

    expect(startHotMock).not.toHaveBeenCalled();
  });

  it('passes requireIdentity true only when service.healthIdentity is true', async () => {
    const withIdentity = manifest({
      api: runnableRepo({ ports: [httpSlot(3000)], healthIdentity: true }),
    });
    await startResolvedService({
      store,
      manifest: withIdentity,
      ticketId: 7,
      name: 'api',
      resolved: resolvedFor('api', { http: 4123 }, { PORT: '4123' }),
      cwd: '/wt/api',
      envOverrides: {},
    });
    expect(startHotMock.mock.calls[0]![1].requireIdentity).toBe(true);

    startHotMock.mockClear();

    const withoutIdentity = manifest({ api: runnableRepo({ ports: [httpSlot(3000)] }) });
    await startResolvedService({
      store,
      manifest: withoutIdentity,
      ticketId: 7,
      name: 'api',
      resolved: resolvedFor('api', { http: 4124 }, { PORT: '4124' }),
      cwd: '/wt/api',
      envOverrides: {},
    });
    expect(startHotMock.mock.calls[0]![1].requireIdentity).toBe(false);
  });
});
