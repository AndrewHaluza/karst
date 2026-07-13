import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { stopServer } from './supervisor.js';
import { spinTicket, SpinCancelledError } from './spin.js';
import { worktreeSlug } from './slug.js';
import type { Manifest } from '../manifest/types.js';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** Backend: serves /health and /api/data. Reads PORT from env. */
const BACKEND_SRC = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/api/data') { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({value:'from-backend'})); return; }
  res.writeHead(404); res.end();
}).listen(port);
`;

/** Frontend: fetches VITE_API_URL/api/data and re-serves the value at /. */
const FRONTEND_SRC = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
const api = process.env.VITE_API_URL;
createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/') {
    try { const r = await fetch(api + '/api/data'); const b = await r.json();
      res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({proxied:b.value})); }
    catch(e){ res.writeHead(502); res.end(String(e)); }
    return;
  }
  res.writeHead(404); res.end();
}).listen(port);
`;

/** Frontend that binds its port but never answers /health — to hang the health gate. */
const NEVER_HEALTHY_FE = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
createServer((_req, res) => { res.writeHead(503); res.end('warming'); }).listen(port);
`;

/** Contracts: minimal service that records start order via a shared log file. */
function orderRecorderSrc(orderLog: string, name: string): string {
  return `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const port = Number(process.env.PORT);
appendFileSync(${JSON.stringify(orderLog)}, '${name}\\n');
createServer((req,res)=>{ if(req.url==='/health'){res.writeHead(200);res.end('ok');return;} res.writeHead(404);res.end(); }).listen(port);
`;
}

function makeRepo(root: string, name: string, files: Record<string, string>): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(repo, rel), content);
  git(repo, 'init', '-q', '-b', 'develop');
  git(repo, 'config', 'user.email', 't@k.local');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

let portBase = 48600;
function port(): number {
  return portBase++;
}

describe('spinTicket integration', () => {
  let store: Store;
  let root: string;
  const started: number[] = [];

  beforeEach(() => {
    store = openStore(':memory:');
    root = mkdtempSync(join(tmpdir(), 'karst-spin-'));
  });
  afterEach(() => {
    for (const s of store.db.prepare("SELECT id FROM servers WHERE status='running'").all()) {
      stopServer(store, (s as { id: number }).id);
    }
    started.length = 0;
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('(a) frontend-only hot → worktree + baseline backend, request through FE reaches BE', async () => {
    const bePort = port();
    const fePort = port(); // not used directly; allocator picks alt from range
    const backend = makeRepo(root, 'backend', { 'server.mjs': BACKEND_SRC });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': FRONTEND_SRC });

    const manifest: Manifest = {
      host: '127.0.0.1',
      portRange: [fePort, fePort + 20],
      baselineBranch: 'develop',
      services: {
        backend: {
          repoPath: backend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: bePort }], dependsOn: [], hasMigrations: false,
        },
        frontend: {
          repoPath: frontend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: port() }],
          dependsOn: [{ target: 'backend', port: 'http', bind: [{ env: 'VITE_API_URL', template: 'http://{host}:{port}' }] }],
          hasMigrations: false,
        },
      },
    };

    const ticket = createTicket(store, { key: 'PROJ-1', title: 'fe only' });
    const result = await spinTicket(store, manifest, ticket.id, ['frontend']);

    // frontend worktree created
    const wt = store.db.prepare('SELECT path FROM worktrees WHERE ticket_id = ?').get(ticket.id) as { path: string };
    expect(wt.path).toContain(join('frontend', '.karst', 'worktrees'));

    // baseline backend up on its default port
    const beRow = store.db.prepare("SELECT port FROM servers WHERE service='backend' AND ticket_id IS NULL AND status='running'").get() as { port: number };
    expect(beRow.port).toBe(bePort);

    // frontend up on an ALLOCATED alt port (from range), not its default
    const feServer = result.servers.find((s) => s.service === 'frontend')!;
    expect(feServer.port).toBeGreaterThanOrEqual(fePort);
    expect(feServer.status).toBe('running');

    // request through frontend reaches baseline backend
    const res = await fetch(`http://127.0.0.1:${feServer.port}/`);
    const body = await res.json() as { proxied: string };
    expect(body.proxied).toBe('from-backend');

    // baseline ref recorded
    const ref = store.db.prepare('SELECT service FROM baseline_refs WHERE ticket_id = ?').get(ticket.id) as { service: string };
    expect(ref.service).toBe('backend');
  });

  it('(a3) spins over a leftover branch from a prior aborted spin by attaching to it', async () => {
    const bePort = port();
    const fePort = port();
    const backend = makeRepo(root, 'backend', { 'server.mjs': BACKEND_SRC });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': FRONTEND_SRC });

    const manifest: Manifest = {
      host: '127.0.0.1',
      portRange: [fePort, fePort + 20],
      baselineBranch: 'develop',
      services: {
        backend: {
          repoPath: backend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: bePort }], dependsOn: [], hasMigrations: false,
        },
        frontend: {
          repoPath: frontend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: port() }],
          dependsOn: [{ target: 'backend', port: 'http', bind: [{ env: 'VITE_API_URL', template: 'http://{host}:{port}' }] }],
          hasMigrations: false,
        },
      },
    };

    const ticket = createTicket(store, { key: 'PROJ-3', title: 'leftover' });
    // Leftover branch a prior spin created and never cleaned up (the reported bug).
    git(frontend, 'branch', `karst/${worktreeSlug(ticket)}`, 'develop');

    const result = await spinTicket(store, manifest, ticket.id, ['frontend']);

    const feServer = result.servers.find((s) => s.service === 'frontend')!;
    expect(feServer.status).toBe('running');
    const res = await fetch(`http://127.0.0.1:${feServer.port}/`);
    const body = await res.json() as { proxied: string };
    expect(body.proxied).toBe('from-backend');
  });

  it('(a4) resumes a half-spun ticket — worktree+row survive, ports gone — by adopting', async () => {
    const bePort = port();
    const fePort = port();
    const backend = makeRepo(root, 'backend', { 'server.mjs': BACKEND_SRC });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': FRONTEND_SRC });

    const manifest: Manifest = {
      host: '127.0.0.1',
      portRange: [fePort, fePort + 20],
      baselineBranch: 'develop',
      services: {
        backend: {
          repoPath: backend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: bePort }], dependsOn: [], hasMigrations: false,
        },
        frontend: {
          repoPath: frontend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: port() }],
          dependsOn: [{ target: 'backend', port: 'http', bind: [{ env: 'VITE_API_URL', template: 'http://{host}:{port}' }] }],
          hasMigrations: false,
        },
      },
    };

    const ticket = createTicket(store, { key: 'PROJ-4', title: 'resume' });
    await spinTicket(store, manifest, ticket.id, ['frontend']);

    // Simulate a spin that died after createWorktree: kill running servers and
    // wipe the ticket's transient rows, but LEAVE the worktree (git + DB row) —
    // exactly the drifted state that blocked ticket #2.
    for (const s of store.db.prepare("SELECT id FROM servers WHERE status='running'").all()) {
      stopServer(store, (s as { id: number }).id);
    }
    store.db.prepare('DELETE FROM servers WHERE ticket_id = ?').run(ticket.id);
    store.db.prepare('DELETE FROM port_allocations WHERE ticket_id = ?').run(ticket.id);
    const wtBefore = store.db.prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?').get(ticket.id) as { n: number };
    expect(wtBefore.n).toBe(1); // worktree leftover, as in the reported bug

    // Retry: adopts the existing worktree, re-resolves fresh, comes up running.
    const result = await spinTicket(store, manifest, ticket.id, ['frontend']);

    const feServer = result.servers.find((s) => s.service === 'frontend')!;
    expect(feServer.status).toBe('running');
    const res = await fetch(`http://127.0.0.1:${feServer.port}/`);
    const body = await res.json() as { proxied: string };
    expect(body.proxied).toBe('from-backend');

    // No duplicate worktree row from the retry.
    const wtAfter = store.db.prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?').get(ticket.id) as { n: number };
    expect(wtAfter.n).toBe(1);
  });

  it('(a5) cancel mid-health tears down the run — fresh worktree removed, ports freed, no server', async () => {
    const bePort = port();
    const fePort = port();
    const backend = makeRepo(root, 'backend', { 'server.mjs': BACKEND_SRC });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': NEVER_HEALTHY_FE });

    const manifest: Manifest = {
      host: '127.0.0.1',
      portRange: [fePort, fePort + 20],
      baselineBranch: 'develop',
      services: {
        backend: {
          repoPath: backend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: bePort }], dependsOn: [], hasMigrations: false,
        },
        frontend: {
          repoPath: frontend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: port() }],
          dependsOn: [{ target: 'backend', port: 'http', bind: [{ env: 'VITE_API_URL', template: 'http://{host}:{port}' }] }],
          hasMigrations: false,
        },
      },
    };

    const ticket = createTicket(store, { key: 'PROJ-5', title: 'cancel' });
    const ctrl = new AbortController();
    // Cancel once the frontend is spawned and stuck in its health wait.
    setTimeout(() => ctrl.abort(), 700);

    await expect(
      spinTicket(store, manifest, ticket.id, ['frontend'], { signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(SpinCancelledError);

    // Fresh worktree removed on teardown.
    const wt = store.db.prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?').get(ticket.id) as { n: number };
    expect(wt.n).toBe(0);
    // Ports released.
    const ports = store.db.prepare('SELECT COUNT(*) AS n FROM port_allocations WHERE ticket_id = ?').get(ticket.id) as { n: number };
    expect(ports.n).toBe(0);
    // No ticket server left running.
    const running = store.db.prepare("SELECT COUNT(*) AS n FROM servers WHERE ticket_id = ? AND status='running'").get(ticket.id) as { n: number };
    expect(running.n).toBe(0);
  });

  it('(a6) cancel keeps an ADOPTED worktree — only ports/servers cleaned', async () => {
    const bePort = port();
    const fePort = port();
    const backend = makeRepo(root, 'backend', { 'server.mjs': BACKEND_SRC });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': NEVER_HEALTHY_FE });

    const manifest: Manifest = {
      host: '127.0.0.1',
      portRange: [fePort, fePort + 20],
      baselineBranch: 'develop',
      services: {
        backend: {
          repoPath: backend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: bePort }], dependsOn: [], hasMigrations: false,
        },
        frontend: {
          repoPath: frontend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: port() }],
          dependsOn: [{ target: 'backend', port: 'http', bind: [{ env: 'VITE_API_URL', template: 'http://{host}:{port}' }] }],
          hasMigrations: false,
        },
      },
    };

    const ticket = createTicket(store, { key: 'PROJ-6', title: 'cancel-adopt' });
    // Pre-create the worktree + its row, so this spin ADOPTS rather than creates it.
    const wtDir = join(frontend, '.karst', 'worktrees', worktreeSlug(ticket));
    git(frontend, 'worktree', 'add', '-q', '-b', `karst/${worktreeSlug(ticket)}`, wtDir, 'develop');
    store.db
      .prepare(`INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
                VALUES (?, ?, ?, ?, 'develop', 'inherited')`)
      .run(ticket.id, frontend, wtDir, `karst/${worktreeSlug(ticket)}`);

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 700);
    await expect(
      spinTicket(store, manifest, ticket.id, ['frontend'], { signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(SpinCancelledError);

    // Adopted worktree row + git worktree survive.
    const wt = store.db.prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?').get(ticket.id) as { n: number };
    expect(wt.n).toBe(1);
    // Ports still released.
    const ports = store.db.prepare('SELECT COUNT(*) AS n FROM port_allocations WHERE ticket_id = ?').get(ticket.id) as { n: number };
    expect(ports.n).toBe(0);
  });

  it('(a2) a wrong baselineBranch rejects via preflight and leaves the DB untouched', async () => {
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': FRONTEND_SRC }); // on develop
    const manifest: Manifest = {
      host: '127.0.0.1',
      portRange: [port(), port() + 20],
      baselineBranch: 'nonexistent-branch', // not in the repo
      services: {
        frontend: {
          repoPath: frontend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: port() }], dependsOn: [], hasMigrations: false,
        },
      },
    };
    const ticket = createTicket(store, { key: 'PROJ-9', title: 'bad branch' });

    await expect(spinTicket(store, manifest, ticket.id, ['frontend'])).rejects.toThrow(
      /Cannot spin/,
    );

    // preflight ran before any mutation — nothing was written.
    const wtCount = store.db.prepare('SELECT COUNT(*) c FROM worktrees WHERE ticket_id = ?').get(ticket.id) as { c: number };
    const portCount = store.db.prepare('SELECT COUNT(*) c FROM port_allocations WHERE ticket_id = ?').get(ticket.id) as { c: number };
    const srvCount = store.db.prepare('SELECT COUNT(*) c FROM servers WHERE ticket_id = ?').get(ticket.id) as { c: number };
    expect(wtCount.c).toBe(0);
    expect(portCount.c).toBe(0);
    expect(srvCount.c).toBe(0);
  });

  it('(b) 3-node chain all hot → services start in dependency-first order', async () => {
    const orderLog = join(root, 'order.log');
    const contracts = makeRepo(root, 'contracts', { 'server.mjs': orderRecorderSrc(orderLog, 'contracts') });
    const backend = makeRepo(root, 'backend', { 'server.mjs': orderRecorderSrc(orderLog, 'backend') });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': orderRecorderSrc(orderLog, 'frontend') });

    const base = port();
    const manifest: Manifest = {
      host: '127.0.0.1',
      portRange: [base, base + 30],
      baselineBranch: 'develop',
      services: {
        contracts: {
          repoPath: contracts, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: port() }], dependsOn: [], hasMigrations: false,
        },
        backend: {
          repoPath: backend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: port() }],
          dependsOn: [{ target: 'contracts', port: 'http', bind: [{ env: 'CONTRACTS_URL', template: 'http://{host}:{port}' }] }],
          hasMigrations: false,
        },
        frontend: {
          repoPath: frontend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: port() }],
          dependsOn: [{ target: 'backend', port: 'http', bind: [{ env: 'API', template: 'http://{host}:{port}' }] }],
          hasMigrations: false,
        },
      },
    };

    const ticket = createTicket(store, { key: 'PROJ-2', title: 'chain' });
    await spinTicket(store, manifest, ticket.id, ['contracts', 'backend', 'frontend']);

    const { readFileSync } = await import('node:fs');
    const order = readFileSync(orderLog, 'utf8').trim().split('\n');
    expect(order).toEqual(['contracts', 'backend', 'frontend']); // dependency-first
  });

  it('a second ticket reuses the same baseline backend (no double-start)', async () => {
    const bePort = port();
    const backend = makeRepo(root, 'backend', { 'server.mjs': BACKEND_SRC });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': FRONTEND_SRC });
    const fePort = port();

    const manifest: Manifest = {
      host: '127.0.0.1',
      portRange: [fePort, fePort + 30],
      baselineBranch: 'develop',
      services: {
        backend: {
          repoPath: backend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: bePort }], dependsOn: [], hasMigrations: false,
        },
        frontend: {
          repoPath: frontend, start: 'node server.mjs', health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: port() }],
          dependsOn: [{ target: 'backend', port: 'http', bind: [{ env: 'VITE_API_URL', template: 'http://{host}:{port}' }] }],
          hasMigrations: false,
        },
      },
    };

    const t1 = createTicket(store, { key: 'PROJ-A', title: 'a' });
    const t2 = createTicket(store, { key: 'PROJ-B', title: 'b' });
    await spinTicket(store, manifest, t1.id, ['frontend']);
    await spinTicket(store, manifest, t2.id, ['frontend']);

    const baselines = store.db.prepare("SELECT COUNT(*) AS n FROM servers WHERE service='backend' AND ticket_id IS NULL AND status='running'").get() as { n: number };
    expect(baselines.n).toBe(1); // one baseline shared by both tickets
  });
});
