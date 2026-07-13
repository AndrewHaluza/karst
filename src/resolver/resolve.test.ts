import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { makePortAllocator } from './allocator.js';
import { resolve } from './resolve.js';
import type { Manifest } from '../manifest/types.js';

/** Ticket id used for allocation in these unit tests. */
const TID = 1;

function slot(name: string, env: string, def: number) {
  return { name, env, default: def };
}

/** backend(3000) <- frontend(5173, VITE_API_URL) ; contracts(6000) standalone */
function manifest(): Manifest {
  return {
    host: 'localhost',
    portRange: [4000, 4999],
    baselineBranch: 'develop',
    services: {
      backend: {
        repoPath: '../backend',
        start: 'npm run dev',
        health: 'http://{host}:{port}/health',
        ports: [slot('http', 'PORT', 3000), slot('debug', 'DEBUG_PORT', 9229)],
        dependsOn: [],
        hasMigrations: false,
      },
      frontend: {
        repoPath: '../frontend',
        start: 'npm run dev',
        ports: [slot('http', 'PORT', 5173)],
        dependsOn: [
          {
            target: 'backend',
            port: 'http',
            bind: [{ env: 'VITE_API_URL', template: 'http://{host}:{port}' }],
          },
        ],
        hasMigrations: false,
      },
      contracts: {
        repoPath: '../contracts',
        start: 'npm run watch',
        ports: [slot('http', 'PORT', 6000)],
        dependsOn: [],
        hasMigrations: false,
      },
    },
  };
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
    m.services.frontend!.dependsOn[0]!.bind = [
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
    m.services.backend!.dependsOn = [
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
    m.services.backend!.dependsOn = [
      { target: 'frontend', port: 'http', bind: [{ env: 'FE', template: 'http://{host}:{port}' }] },
    ];
    // frontend depends on backend, backend depends on frontend → cycle
    expect(() => resolve(m, ['backend', 'frontend'], alloc(), 1)).toThrow(/cycle/i);
  });

  it('startOrder lists only hot services', () => {
    const r = resolve(manifest(), ['frontend'], alloc(), 1);
    expect(r.startOrder).toEqual(['frontend']);
  });

  it('allocates ports under the passed ticketId, not a hardcoded one', () => {
    resolve(manifest(), ['frontend'], alloc(), 42);
    const rows = store.db
      .prepare('SELECT DISTINCT ticket_id FROM port_allocations')
      .all() as { ticket_id: number }[];
    expect(rows).toEqual([{ ticket_id: 42 }]);
  });
});
