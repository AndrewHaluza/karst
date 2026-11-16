import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { startHot } from './supervisor.js';
import { startResolvedService } from './startService.js';
import { waitForHealth } from './health.js';
import { startSandboxService } from '../agent/sandboxServices.js';
import type { ResolveResult } from '../resolver/resolve.js';
import { httpSlot, manifest, runnableRepo } from '../manifest/fixtures.js';

vi.mock('./supervisor.js', () => ({ startHot: vi.fn() }));
vi.mock('../agent/sandboxServices.js', async (orig) => ({
  ...(await orig<typeof import('../agent/sandboxServices.js')>()),
  startSandboxService: vi.fn(() => Promise.resolve({ id: 1 })),
}));

vi.mock('./health.js', async (orig) => ({
  ...(await orig<typeof import('./health.js')>()),
  waitForHealth: vi.fn(() => Promise.resolve()),
}));

const resolved: ResolveResult = {
  services: { api: { mode: 'hot', ports: { http: 4123 }, env: { PORT: '4123' }, baselineDeps: [] } },
  nonRunnable: [],
  startOrder: ['api'],
};
const sandbox = { runner: { kind: 'sbx' as const }, sandboxName: 'karst-ab-7-claude' };

describe('startResolvedService: sandboxed ticket (arch:AC-32)', () => {
  let store: Store;
  beforeEach(() => { store = openStore(':memory:'); vi.mocked(startSandboxService).mockClear(); vi.mocked(startHot).mockClear(); });
  afterEach(() => store.close());

  it('starts inside the sandbox, never on the host, with health on the published 127.0.0.1 port', async () => {
    const m = manifest({ api: runnableRepo({ ports: [httpSlot(3000)], start: 'npm run dev -- --port ${PORT}' }) });
    await startResolvedService({ store, manifest: m, ticketId: 7, name: 'api', resolved, cwd: '/wt/api', envOverrides: {}, sandbox });
    expect(startHot).not.toHaveBeenCalled();
    const input = vi.mocked(startSandboxService).mock.calls[0]![0];
    expect(input).toMatchObject({
      sandboxName: 'karst-ab-7-claude', ticketId: 7, service: 'api', command: 'npm',
      args: ['run', 'dev', '--', '--port', '4123'], worktree: '/wt/api', serviceCwd: '/wt/api', port: 4123,
    });
    expect(input.env.PORT).toBe('4123');
    expect(input.env.HOME).toBeUndefined();
    expect(input.healthUrlFor(4200)).toBe('http://127.0.0.1:4200/health');
    await expect(input.reallocate(4123)).resolves.toBeGreaterThan(0);
  });

  it('renders a declared health template against the published host side', async () => {
    const m = manifest({ api: runnableRepo({ ports: [httpSlot(3000)], health: 'http://{host}:{port}/ready' }) });
    await startResolvedService({ store, manifest: m, ticketId: 7, name: 'api', resolved, cwd: '/wt/api', envOverrides: {}, sandbox });
    expect(vi.mocked(startSandboxService).mock.calls[0]![0].healthUrlFor(4200)).toBe('http://127.0.0.1:4200/ready');
  });

  it('waits for sandboxed health with the declared timeout, and the default without one', async () => {
    const withTimeout = manifest({ api: runnableRepo({ ports: [httpSlot(3000)], healthTimeoutSeconds: 120 }) });
    await startResolvedService({ store, manifest: withTimeout, ticketId: 7, name: 'api', resolved, cwd: '/wt/api', envOverrides: {}, sandbox });
    await vi.mocked(startSandboxService).mock.calls[0]![0].waitHealthy('http://127.0.0.1:4123/health');
    expect(vi.mocked(waitForHealth)).toHaveBeenLastCalledWith('http://127.0.0.1:4123/health', { timeoutMs: 120_000 });

    vi.mocked(startSandboxService).mockClear();
    vi.mocked(waitForHealth).mockClear();
    const without = manifest({ api: runnableRepo({ ports: [httpSlot(3000)] }) });
    await startResolvedService({ store, manifest: without, ticketId: 7, name: 'api', resolved, cwd: '/wt/api', envOverrides: {}, sandbox });
    const input = vi.mocked(startSandboxService).mock.calls[0]![0];
    await input.waitHealthy('u');
    expect(vi.mocked(waitForHealth)).toHaveBeenLastCalledWith('u', {});
    const ac = new AbortController();
    await input.waitHealthy('u', ac.signal);
    expect(vi.mocked(waitForHealth)).toHaveBeenLastCalledWith('u', { signal: ac.signal });
  });

  it('refuses a docker-image service inside a sandbox', async () => {
    const m = manifest({ api: runnableRepo({ ports: [httpSlot(3000)], docker: { image: 'redis:7' } as never }) });
    await expect(startResolvedService({ store, manifest: m, ticketId: 7, name: 'api', resolved, cwd: '/wt/api', envOverrides: {}, sandbox }))
      .rejects.toThrow('declare `sandbox: host`');
    await expect(startResolvedService({ store, manifest: m, ticketId: 7, name: 'api', resolved, cwd: '/wt/api', envOverrides: {}, sandbox }))
      .rejects.toThrow('cannot run inside a sandbox');
  });

  it('starts a sandbox: host service on the host for a sandboxed ticket', async () => {
    const m = manifest({ api: runnableRepo({ ports: [httpSlot(3000)], start: 'npm run dev', sandbox: 'host' }) });
    const debug = vi.fn();
    await startResolvedService({ store, manifest: m, ticketId: 7, name: 'api', resolved, cwd: '/wt/api', envOverrides: {}, sandbox, debug });
    expect(startSandboxService).not.toHaveBeenCalled();
    expect(startHot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startHot).mock.calls[0]![1]).toEqual(expect.objectContaining({ ticketId: 7, service: 'api', cwd: '/wt/api', port: 4123 }));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('declares sandbox: host'));
  });

  it('runs a sandbox: host docker service on the host instead of refusing it', async () => {
    const docker = { image: 'redis:7', containerPort: 6379, env: {}, volumes: [], args: [] } as never;
    const m = manifest({ api: runnableRepo({ ports: [httpSlot(3000)], docker, sandbox: 'host' }) });
    await expect(startResolvedService({ store, manifest: m, ticketId: 7, name: 'api', resolved, cwd: '/wt/api', envOverrides: {}, sandbox })).resolves.not.toThrow();
    expect(startHot).toHaveBeenCalledTimes(1);
    expect(startSandboxService).not.toHaveBeenCalled();
  });

  it('keeps an inside service in the sandbox', async () => {
    const m = manifest({ api: runnableRepo({ ports: [httpSlot(3000)], sandbox: 'inside' }) });
    await startResolvedService({ store, manifest: m, ticketId: 7, name: 'api', resolved, cwd: '/wt/api', envOverrides: {}, sandbox });
    expect(startSandboxService).toHaveBeenCalledTimes(1);
    expect(startHot).not.toHaveBeenCalled();
  });
});
