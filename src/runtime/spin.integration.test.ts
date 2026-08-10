import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { stopServer } from './supervisor.js';
import { spinTicket, SpinCancelledError } from './spin.js';
import { worktreeSlug } from './slug.js';
import { createWorktree } from './worktree.js';
import { freePortWindow, removeTempDir } from './fixtures.js';
import type { DependsOn, Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';
import {
  dependsOn,
  httpSlot,
  manifest as buildManifest,
  repo as bareRepo,
  runnableRepo,
} from '../manifest/fixtures.js';

// Wraps the real implementation (still calls through) so the dedup test below
// can assert HOW MANY TIMES createWorktree is invoked, without changing any
// other test's behavior in this file.
vi.mock('./worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worktree.js')>();
  return { ...actual, createWorktree: vi.fn(actual.createWorktree) };
});

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

// Rebased onto a window this machine has proven free (see freePortWindow): each
// case draws default ports AND a 20-30 port allocator range from it.
let portBase = 48600;
function port(): number {
  return portBase++;
}

/** A runnable repo running `server.mjs` and answering /health on `defaultPort`. */
function node(
  repoPath: string,
  defaultPort: number,
  over: Partial<ServiceDef> = {},
): RepositoryDef {
  return runnableRepo(
    {
      start: 'node server.mjs',
      health: 'http://{host}:{port}/health',
      ports: [httpSlot(defaultPort)],
      ...over,
    },
    { repoPath },
  );
}

/** A repository with no service: worktree only, nothing ever starts. */
function plainRepo(repoPath: string): RepositoryDef {
  return bareRepo({ repoPath });
}

/** Bind `target`'s http port into `env` on the dependent. */
function bindHttp(target: string, env: string): DependsOn[] {
  return [dependsOn(target, 'http', [{ env, template: 'http://{host}:{port}' }])];
}

/**
 * The canonical backend <- frontend pair most cases below spin. The frontend's
 * own default port is drawn fresh from `port()` (the allocator overrides it when
 * the service is hot; it matters only for the baseline path).
 */
function feBeManifest(opts: {
  backend: string;
  frontend: string;
  bePort: number;
  fePort: number;
  span?: number;
}): Manifest {
  return buildManifest(
    {
      backend: node(opts.backend, opts.bePort),
      frontend: node(opts.frontend, port(), {
        dependsOn: bindHttp('backend', 'VITE_API_URL'),
      }),
    },
    { host: '127.0.0.1', portRange: [opts.fePort, opts.fePort + (opts.span ?? 20)] },
  );
}

describe('spinTicket integration', () => {
  let store: Store;
  let root: string;
  const started: number[] = [];

  beforeAll(async () => {
    // Ceiling keeps this probe inside the suite's own band: supervisor and
    // baseline own [48200, 48400) and [48400, 48600) respectively, so a window
    // blocked by a leftover server THROWS loudly ("leaked servers") instead of
    // sliding into a sibling suite's band and drawing the same ports it draws.
    portBase = await freePortWindow(140, portBase, 49000);
  });
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
    // Retried: the servers stopped just above ran with their worktree as cwd, and
    // Windows keeps that directory pinned for a moment after the process dies.
    removeTempDir(root);
  });

  it('(a) frontend-only hot → worktree + baseline backend, request through FE reaches BE', async () => {
    const bePort = port();
    const fePort = port(); // not used directly; allocator picks alt from range
    const backend = makeRepo(root, 'backend', { 'server.mjs': BACKEND_SRC });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': FRONTEND_SRC });

    const manifest = feBeManifest({ backend, frontend, bePort, fePort });

    const ticket = createTicket(store, { key: 'PROJ-1', title: 'fe only' });
    const result = await spinTicket(store, manifest, ticket.id, ['frontend']);

    // frontend worktree created
    const wt = store.db.prepare('SELECT path FROM worktrees WHERE ticket_id = ?').get(ticket.id) as { path: string };
    expect(wt.path).toContain(join('frontend', '.karst', 'worktrees'));

    // baseline backend up on its default port
    const beRow = store.db.prepare("SELECT port FROM servers WHERE repo='backend' AND ticket_id IS NULL AND status='running'").get() as { port: number };
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
    const ref = store.db.prepare('SELECT repo FROM baseline_refs WHERE ticket_id = ?').get(ticket.id) as { repo: string };
    expect(ref.repo).toBe('backend');
  });

  it('(a3) spins over a leftover branch from a prior aborted spin by attaching to it', async () => {
    const bePort = port();
    const fePort = port();
    const backend = makeRepo(root, 'backend', { 'server.mjs': BACKEND_SRC });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': FRONTEND_SRC });

    const manifest = feBeManifest({ backend, frontend, bePort, fePort });

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

    const manifest = feBeManifest({ backend, frontend, bePort, fePort });

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

    const manifest = feBeManifest({ backend, frontend, bePort, fePort });

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

    const manifest = feBeManifest({ backend, frontend, bePort, fePort });

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
    const manifest = buildManifest(
      { frontend: node(frontend, port()) },
      {
        host: '127.0.0.1',
        portRange: [port(), port() + 20],
        baselineBranch: 'nonexistent-branch', // not in the repo
      },
    );
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
    const manifest = buildManifest(
      {
        contracts: node(contracts, port()),
        backend: node(backend, port(), { dependsOn: bindHttp('contracts', 'CONTRACTS_URL') }),
        frontend: node(frontend, port(), { dependsOn: bindHttp('backend', 'API') }),
      },
      { host: '127.0.0.1', portRange: [base, base + 30] },
    );

    const ticket = createTicket(store, { key: 'PROJ-2', title: 'chain' });
    await spinTicket(store, manifest, ticket.id, ['contracts', 'backend', 'frontend']);

    const { readFileSync } = await import('node:fs');
    const order = readFileSync(orderLog, 'utf8').trim().split('\n');
    expect(order).toEqual(['contracts', 'backend', 'frontend']); // dependency-first
  });

  // The motivating case: karst's own extension repo is scoped to a ticket, gets a
  // worktree so the agent can edit it, and starts nothing. Before this it needed a
  // fake `start` and a fake port, and spin threw a TypeError without them.
  it('(c) a hot repo with NO service gets a worktree but no port and no process', async () => {
    const bePort = port();
    const fePort = port();
    const backend = makeRepo(root, 'backend', { 'server.mjs': BACKEND_SRC });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': FRONTEND_SRC });
    const docs = makeRepo(root, 'docs', { 'README.md': '# docs\n' });

    const base = feBeManifest({ backend, frontend, bePort, fePort });
    const manifest: Manifest = {
      ...base,
      repositories: { ...base.repositories, docs: plainRepo(docs) },
    };

    const ticket = createTicket(store, { key: 'PROJ-C', title: 'edit docs too' });
    const result = await spinTicket(store, manifest, ticket.id, ['frontend', 'docs']);

    // Both repos got a worktree — the docs branch is what the agent edits on.
    const wts = store.db
      .prepare('SELECT repo FROM worktrees WHERE ticket_id = ? ORDER BY repo')
      .all(ticket.id) as { repo: string }[];
    expect(wts.map((w) => w.repo).sort()).toEqual([docs, frontend].sort());

    // Exactly one server, and it is the frontend — docs started nothing.
    expect(result.servers.map((s) => s.service)).toEqual(['frontend']);
    const docsServers = store.db
      .prepare("SELECT COUNT(*) AS n FROM servers WHERE repo = 'docs'")
      .get() as { n: number };
    expect(docsServers.n).toBe(0);

    // And no port was allocated to it.
    const docsPorts = store.db
      .prepare("SELECT COUNT(*) AS n FROM port_allocations WHERE ticket_id = ? AND repo = 'docs'")
      .get(ticket.id) as { n: number };
    expect(docsPorts.n).toBe(0);
  });

  it('(c2) a hot set of ONLY non-runnable repos spins to a worktree and no servers', async () => {
    const docs = makeRepo(root, 'docs', { 'README.md': '# docs\n' });
    const base = port();
    const manifest = buildManifest(
      { docs: plainRepo(docs) },
      { host: '127.0.0.1', portRange: [base, base + 10] },
    );

    const ticket = createTicket(store, { key: 'PROJ-C2', title: 'docs only' });
    const result = await spinTicket(store, manifest, ticket.id, ['docs']);

    expect(result.servers).toEqual([]);
    const wt = store.db
      .prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?')
      .get(ticket.id) as { n: number };
    expect(wt.n).toBe(1);
  });

  // Two repository ENTRIES sharing one repoPath (a monorepo with two runnable
  // processes) share ONE worktree — the slug is per-ticket, not per-entry — but
  // still get distinct port allocations and distinct server rows, because those
  // are keyed by repository NAME, not repoPath. Restores the worktreeByRepo
  // dedup 53314d6 added and b7f223d wrongly deleted.
  it('(d) two hot repository entries sharing one repoPath share ONE worktree but get distinct ports/servers', async () => {
    const base = port();
    const mono = makeRepo(root, 'mono', {
      'api.mjs': BACKEND_SRC,
      'web.mjs': BACKEND_SRC,
    });
    const manifest = buildManifest(
      {
        api: node(mono, port(), { start: 'node api.mjs' }),
        web: node(mono, port(), { start: 'node web.mjs' }),
      },
      { host: '127.0.0.1', portRange: [base, base + 20] },
    );

    const ticket = createTicket(store, { key: 'PROJ-D', title: 'monorepo two services' });
    const before = vi.mocked(createWorktree).mock.calls.length;
    const result = await spinTicket(store, manifest, ticket.id, ['api', 'web']);
    const callsDuringSpin = vi.mocked(createWorktree).mock.calls.length - before;

    // one worktree CREATED (not once per repository entry)…
    expect(callsDuringSpin).toBe(1);
    // …and one worktree ROW, shared by both entries.
    const wt = store.db
      .prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?')
      .get(ticket.id) as { n: number };
    expect(wt.n).toBe(1);

    // both services started, on distinct ports.
    expect(result.servers.map((s) => s.service).sort()).toEqual(['api', 'web']);
    const apiSrv = result.servers.find((s) => s.service === 'api')!;
    const webSrv = result.servers.find((s) => s.service === 'web')!;
    expect(apiSrv.status).toBe('running');
    expect(webSrv.status).toBe('running');
    expect(apiSrv.port).not.toBe(webSrv.port);

    // distinct port allocations, keyed by repository name (not repoPath).
    const allocations = store.db
      .prepare('SELECT repo, port FROM port_allocations WHERE ticket_id = ? ORDER BY repo')
      .all(ticket.id) as { repo: string; port: number }[];
    expect(allocations.map((a) => a.repo)).toEqual(['api', 'web']);
    expect(allocations[0]!.port).not.toBe(allocations[1]!.port);

    // distinct server rows, keyed by repository name.
    const serverRows = store.db
      .prepare("SELECT repo, port FROM servers WHERE ticket_id = ? AND status='running' ORDER BY repo")
      .all(ticket.id) as { repo: string; port: number }[];
    expect(serverRows.map((r) => r.repo)).toEqual(['api', 'web']);
    expect(serverRows[0]!.port).not.toBe(serverRows[1]!.port);
  });

  // Renaming a repository in karst.yml re-keys everything the registry stores by
  // repository NAME. `startHot` only replaces a row of the SAME name, so the old
  // name's retained (offline) row survived every later spin and rendered on the
  // dashboard beside the new one — the same stack listed twice, under both names,
  // with a Restart button that could never resolve the vanished manifest key.
  it('reaps a renamed repository’s orphan server row on the next spin', async () => {
    const base = port();
    const beRepo = makeRepo(root, 'be', { 'server.mjs': BACKEND_SRC });
    const feRepo = makeRepo(root, 'fe', { 'server.mjs': BACKEND_SRC });
    const manifest = buildManifest(
      { BE: node(beRepo, port()), FE: node(feRepo, port()) },
      { host: '127.0.0.1', portRange: [base, base + 20] },
    );

    const ticket = createTicket(store, { key: 'PROJ-R', title: 'renamed repos' });
    const seed = store.db.prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path)
       VALUES (?, ?, '127.0.0.1', 3000, NULL, 'stopped', '/tmp/x.log')`,
    );
    seed.run(ticket.id, 'backend'); // pre-rename name of BE
    seed.run(ticket.id, 'frontend'); // pre-rename name of FE
    seed.run(ticket.id, 'FE'); // still in the manifest — merely not hot this spin

    await spinTicket(store, manifest, ticket.id, ['BE']);

    const rows = store.db
      .prepare('SELECT repo, status FROM servers WHERE ticket_id = ? ORDER BY repo')
      .all(ticket.id) as { repo: string; status: string }[];
    // The vanished names are gone; the deselected-but-declared repo keeps its
    // offline row, because the user chose not to start it — it was not renamed.
    expect(rows).toEqual([
      { repo: 'BE', status: 'running' },
      { repo: 'FE', status: 'stopped' },
    ]);
  });

  it('a second ticket reuses the same baseline backend (no double-start)', async () => {
    const bePort = port();
    const backend = makeRepo(root, 'backend', { 'server.mjs': BACKEND_SRC });
    const frontend = makeRepo(root, 'frontend', { 'server.mjs': FRONTEND_SRC });
    const fePort = port();

    const manifest = feBeManifest({ backend, frontend, bePort, fePort, span: 30 });

    const t1 = createTicket(store, { key: 'PROJ-A', title: 'a' });
    const t2 = createTicket(store, { key: 'PROJ-B', title: 'b' });
    await spinTicket(store, manifest, t1.id, ['frontend']);
    await spinTicket(store, manifest, t2.id, ['frontend']);

    const baselines = store.db.prepare("SELECT COUNT(*) AS n FROM servers WHERE repo='backend' AND ticket_id IS NULL AND status='running'").get() as { n: number };
    expect(baselines.n).toBe(1); // one baseline shared by both tickets
  });
});
