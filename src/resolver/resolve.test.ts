import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { makePortAllocator } from './allocator.js';
import { resolve } from './resolve.js';
import type { Manifest } from '../manifest/types.js';
import {
  dependsOn,
  httpSlot,
  manifest as buildManifest,
  repo,
  runnableRepo,
  slot,
  svc,
} from '../manifest/fixtures.js';

/** Ticket id used for allocation in these unit tests. */
const TID = 1;

/** backend(3000) <- frontend(5173, VITE_API_URL) ; contracts(6000) standalone */
function manifest(): Manifest {
  return buildManifest({
    backend: runnableRepo(
      {
        health: 'http://{host}:{port}/health',
        ports: [httpSlot(3000), slot('debug', 'DEBUG_PORT', 9229)],
      },
      { repoPath: '../backend' },
    ),
    frontend: runnableRepo(
      {
        ports: [httpSlot(5173)],
        dependsOn: [
          dependsOn('backend', 'http', [
            { env: 'VITE_API_URL', template: 'http://{host}:{port}' },
          ]),
        ],
      },
      { repoPath: '../frontend' },
    ),
    contracts: runnableRepo(
      { start: 'npm run watch', ports: [httpSlot(6000)] },
      { repoPath: '../contracts' },
    ),
    // Not runnable: no service, no port. Must never reach startOrder.
    docs: repo({ repoPath: '../docs' }),
  });
}

describe('resolve', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function alloc() {
    return makePortAllocator(store, [4000, 4999]);
  }

  // Case 1: frontend-only hot → alt PORT, VITE_API_URL points at backend DEFAULT.
  it('frontend-only hot → alt port, backend ref uses default port', () => {
    const r = resolve(manifest(), ['frontend'], alloc(), 1);
    const fe = r.services.frontend!;
    expect(fe.mode).toBe('hot');
    expect(fe.ports.http).toBeGreaterThanOrEqual(4000);
    expect(fe.env.PORT).toBe(String(fe.ports.http));
    expect(fe.env.VITE_API_URL).toBe('http://localhost:3000'); // backend default
    expect(fe.baselineDeps).toEqual(['backend']);
    expect(r.services.backend!.mode).toBe('baseline');
  });

  // Case 2: backend-only hot → alt ports; no frontend env produced.
  it('backend-only hot → alt ports, no dependent env', () => {
    const r = resolve(manifest(), ['backend'], alloc(), 1);
    const be = r.services.backend!;
    expect(be.mode).toBe('hot');
    expect(be.ports.http).toBeGreaterThanOrEqual(4000);
    expect(be.ports.debug).toBeGreaterThanOrEqual(4000);
    expect(be.env.PORT).toBe(String(be.ports.http));
    expect(be.env.DEBUG_PORT).toBe(String(be.ports.debug));
    expect(be.baselineDeps).toEqual([]); // no deps
    // frontend is not hot → present as baseline, no resolved env forced
    expect(r.services.frontend!.mode).toBe('baseline');
  });

  // Case 3: both hot → frontend's VITE_API_URL points at backend's ALLOCATED port.
  it('both hot → dependent repoints to the hot target\'s allocated port', () => {
    const r = resolve(manifest(), ['backend', 'frontend'], alloc(), 1);
    const be = r.services.backend!;
    const fe = r.services.frontend!;
    expect(be.mode).toBe('hot');
    expect(fe.mode).toBe('hot');
    expect(fe.env.VITE_API_URL).toBe(`http://localhost:${be.ports.http}`);
    expect(fe.baselineDeps).toEqual([]); // backend is hot, not a baseline dep
  });

  // Case 4: no-deps service → own ports only, empty peer env.
  it('no-deps service → own ports only, no peer vars', () => {
    const r = resolve(manifest(), ['contracts'], alloc(), 1);
    const c = r.services.contracts!;
    expect(c.env.PORT).toBe(String(c.ports.http));
    expect(Object.keys(c.env)).toEqual(['PORT']); // only its own port var
    expect(c.baselineDeps).toEqual([]);
  });

  // Case 5: host templating — {host} renders manifest.host.
  it('renders {host} in a bind template from manifest.host', () => {
    const m = manifest();
    m.host = '127.0.0.1';
    m.repositories.frontend!.service!.dependsOn[0]!.bind = [
      { env: 'BACKEND_HOST', template: '{host}' },
      { env: 'BACKEND_PORT', template: '{port}' },
    ];
    const r = resolve(m, ['frontend'], alloc(), 1);
    const fe = r.services.frontend!;
    expect(fe.env.BACKEND_HOST).toBe('127.0.0.1');
    expect(fe.env.BACKEND_PORT).toBe('3000'); // backend baseline default
  });

  // Case 6: 3-node chain, all hot → startOrder dependency-first; cycle throws.
  it('3-node chain all hot → startOrder is dependency-first', () => {
    const m = manifest();
    // contracts <- backend <- frontend
    m.repositories.backend!.service!.dependsOn = [
      { target: 'contracts', port: 'http', bind: [{ env: 'CONTRACTS_URL', template: 'http://{host}:{port}' }] },
    ];
    const r = resolve(m, ['contracts', 'backend', 'frontend'], alloc(), 1);
    expect(r.startOrder).toEqual(['contracts', 'backend', 'frontend']);
    // backend (hot) now references contracts (hot) → allocated port
    expect(r.services.backend!.env.CONTRACTS_URL).toBe(
      `http://localhost:${r.services.contracts!.ports.http}`,
    );
  });

  it('throws a clear error on a dependency cycle among hot services', () => {
    const m = manifest();
    m.repositories.backend!.service!.dependsOn = [
      { target: 'frontend', port: 'http', bind: [{ env: 'FE', template: 'http://{host}:{port}' }] },
    ];
    // frontend depends on backend, backend depends on frontend → cycle
    expect(() => resolve(m, ['backend', 'frontend'], alloc(), 1)).toThrow(/cycle/i);
  });

  it('startOrder lists only hot services', () => {
    const r = resolve(manifest(), ['frontend'], alloc(), 1);
    expect(r.startOrder).toEqual(['frontend']);
  });

  // A repository with no service has no port and no process. It must not appear
  // in `services` (ports/env are meaningless without one) and must never reach
  // `startOrder`, which spin's start loop iterates.
  describe('repositories with no service', () => {
    it('excludes them from the resolved services map', () => {
      const r = resolve(manifest(), ['frontend'], alloc(), TID);
      expect(r.services.docs).toBeUndefined();
    });

    it('reports them explicitly, so absence is never inferred', () => {
      expect(resolve(manifest(), ['frontend'], alloc(), TID).nonRunnable).toEqual(['docs']);
    });

    it('keeps them out of startOrder even when hot', () => {
      const r = resolve(manifest(), ['frontend', 'docs'], alloc(), TID);
      expect(r.startOrder).toEqual(['frontend']);
    });

    it('allocates no port for them', () => {
      resolve(manifest(), ['docs'], alloc(), TID);
      const rows = store.db
        .prepare('SELECT COUNT(*) AS n FROM port_allocations WHERE ticket_id = ?')
        .get(TID) as { n: number };
      expect(rows.n).toBe(0);
    });

    it('resolves a hot set that is ENTIRELY non-runnable without throwing', () => {
      const r = resolve(manifest(), ['docs'], alloc(), TID);
      expect(r.startOrder).toEqual([]);
      expect(r.services.docs).toBeUndefined();
    });

    it('still throws for a hot name that is not in the manifest at all', () => {
      expect(() => resolve(manifest(), ['ghost'], alloc(), TID)).toThrow(/not in manifest/);
    });
  });

  it('allocates ports under the passed ticketId, not a hardcoded one', () => {
    resolve(manifest(), ['frontend'], alloc(), 42);
    const rows = store.db
      .prepare('SELECT DISTINCT ticket_id FROM port_allocations')
      .all() as { ticket_id: number }[];
    expect(rows).toEqual([{ ticket_id: 42 }]);
  });

  it('allocates a service with a custom portRange inside that range', () => {
    const m = manifest();
    m.repositories.backend!.service!.portRange = [5000, 5100];
    const r = resolve(m, ['backend'], alloc(), TID);
    expect(r.services.backend!.ports.http).toBe(5000); // lowest free wins
    expect(r.services.backend!.ports.debug).toBe(5001);
  });

  it('keeps the global range for services without a portRange', () => {
    const m = manifest();
    m.repositories.backend!.service!.portRange = [5000, 5100];
    const r = resolve(m, ['backend', 'contracts'], alloc(), TID);
    expect(r.services.backend!.ports.http).toBe(5000);
    expect(r.services.contracts!.ports.http).toBe(4000); // global floor
  });

  it('two services with distinct ranges allocate from their own windows', () => {
    const m = manifest();
    m.repositories.backend!.service!.portRange = [5000, 5100];
    m.repositories.frontend!.service!.portRange = [6000, 6100];
    const r = resolve(m, ['backend', 'frontend'], alloc(), TID);
    expect(r.services.backend!.ports.http).toBe(5000);
    expect(r.services.frontend!.ports.http).toBe(6000);
    // effectivePort is untouched: the dependent still repoints at the hot
    // target's ALLOCATED port, which now lives in the target's own window.
    expect(r.services.frontend!.env.VITE_API_URL).toBe('http://localhost:5000');
  });
});

describe('resolve — multi-service repositories', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  /**
   * mono: `api` (ports 3000 + 9229, own window [5000, 5099]) and `web`
   * (port 5173, depends on mono/api's http). client: shorthand service that
   * depends on mono/api. solo: shorthand service a dependant can name as solo/solo.
   */
  function multi(): Manifest {
    return buildManifest({
      mono: repo({
        repoPath: '../mono',
        services: {
          api: svc({
            ports: [httpSlot(3000), slot('debug', 'DEBUG_PORT', 9229)],
            portRange: [5000, 5099],
          }),
          web: svc({
            ports: [httpSlot(5173)],
            dependsOn: [
              dependsOn('mono/api', 'http', [
                { env: 'VITE_API_URL', template: 'http://{host}:{port}' },
              ]),
            ],
          }),
        },
      }),
      client: runnableRepo(
        {
          ports: [httpSlot(8080)],
          dependsOn: [
            dependsOn('mono/api', 'http', [
              { env: 'API_URL', template: 'http://{host}:{port}' },
            ]),
            dependsOn('solo/solo', 'http', [
              { env: 'SOLO_URL', template: 'http://{host}:{port}' },
            ]),
          ],
        },
        { repoPath: '../client' },
      ),
      solo: runnableRepo({ ports: [httpSlot(7000)] }, { repoPath: '../solo' }),
    });
  }

  function alloc() {
    return makePortAllocator(store, [4000, 4999]);
  }

  it('allocates distinct ports to sibling services and honors a per-service window', () => {
    const r = resolve(multi(), ['mono'], alloc(), TID);
    const api = r.services['mono/api']!;
    const web = r.services['mono/web']!;
    expect(api.mode).toBe('hot');
    expect(web.mode).toBe('hot');
    expect(api.ports.http).toBeGreaterThanOrEqual(5000);
    expect(api.ports.http).toBeLessThanOrEqual(5099);
    expect(api.ports.debug).toBeGreaterThanOrEqual(5000);
    expect(api.ports.debug).toBeLessThanOrEqual(5099);
    expect(web.ports.http).toBeGreaterThanOrEqual(4000);
    expect(web.ports.http).toBeLessThanOrEqual(4999);
    const all = [api.ports.http, api.ports.debug, web.ports.http];
    expect(new Set(all).size).toBe(all.length);
  });

  it('orders a sibling dependency before its dependant', () => {
    const r = resolve(multi(), ['mono'], alloc(), TID);
    expect(r.startOrder).toEqual(['mono/api', 'mono/web']);
  });

  it('binds the sibling target allocated port into the dependant env', () => {
    const r = resolve(multi(), ['mono'], alloc(), TID);
    expect(r.services['mono/web']!.env.VITE_API_URL).toBe(
      `http://localhost:${r.services['mono/api']!.ports.http}`,
    );
  });

  it('keys a baseline dependency by its unit key (repo/service)', () => {
    const r = resolve(multi(), ['client'], alloc(), TID);
    expect(r.services['client']!.baselineDeps).toEqual(['mono/api', 'solo']);
    expect(r.services['mono/api']!.mode).toBe('baseline');
    expect(r.startOrder).toEqual(['client']);
  });

  it('binds the baseline default port when the target service is not hot', () => {
    const r = resolve(multi(), ['client'], alloc(), TID);
    expect(r.services['client']!.env.API_URL).toBe('http://localhost:3000');
    expect(r.services['client']!.env.SOLO_URL).toBe('http://localhost:7000');
  });

  it('orders a cross-repo dependency: the target service starts first', () => {
    const r = resolve(multi(), ['client', 'mono'], alloc(), TID);
    const apiIdx = r.startOrder.indexOf('mono/api');
    const webIdx = r.startOrder.indexOf('mono/web');
    const clientIdx = r.startOrder.indexOf('client');
    expect(apiIdx).toBeLessThan(webIdx);
    expect(apiIdx).toBeLessThan(clientIdx);
    // solo is not hot here, so it is a baseline dependency keyed by its shorthand key.
    expect(r.services['client']!.baselineDeps).toEqual(['solo']);
    expect(r.services['client']!.env.API_URL).toBe(
      `http://localhost:${r.services['mono/api']!.ports.http}`,
    );
  });

  it('gives a non-hot sibling its default ports and no injected env', () => {
    const r = resolve(multi(), ['client'], alloc(), TID);
    expect(r.services['mono/web']!.ports.http).toBe(5173);
    expect(r.services['mono/web']!.env).toEqual({});
  });
});
