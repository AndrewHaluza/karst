import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { freePortWindow, removeTempDir } from './fixtures.js';
import { stopServer } from './supervisor.js';
import { ensureBaseline, addBaselineRef } from './baseline.js';
import { worktreeRegisteredAt } from './worktree.js';
import type { ProcessFacts, ProcessFactsSource } from './serverIdentity.js';
import type { Manifest } from '../manifest/types.js';
import { httpSlot, manifest as buildManifest, runnableRepo } from '../manifest/fixtures.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/**
 * A server that reports which git branch's code it is running by reading a
 * committed marker file (BRANCH_MARKER). develop commits "develop"; a later
 * feature branch commits "feature". The baseline must serve the develop marker.
 */
const SERVER_SRC = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const port = Number(process.env.PORT);
const marker = readFileSync(new URL('./marker.txt', import.meta.url), 'utf8').trim();
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/marker') { res.writeHead(200); res.end(marker); return; }
  res.writeHead(404); res.end();
}).listen(port);
`;

let portCounter = 48400;

/** Build a `develop`-then-`feature` repo. `origin` null → a repo with NO remote. */
function buildRepo(dir: string, origin: string | null): void {
  writeFileSync(join(dir, 'server.mjs'), SERVER_SRC);
  writeFileSync(join(dir, 'marker.txt'), 'develop\n');
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 't@k.local');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'develop');
  if (origin) {
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'develop');
  }
  // a feature branch that CHANGES the marker + is left checked out
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'marker.txt'), 'feature\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'feature');
  // repo's current checkout is now `feature`, NOT develop
}

function makeRepo(): { repo: string; origin: string } {
  const origin = mkdtempSync(join(tmpdir(), 'karst-base-origin-'));
  git(origin, 'init', '-q', '--bare');
  const dir = mkdtempSync(join(tmpdir(), 'karst-base-'));
  buildRepo(dir, origin);
  return { repo: dir, origin };
}

/** A repo with no `origin` at all — the fallback-to-local-branch case. */
function makeRepoWithoutRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-base-priv-'));
  buildRepo(dir, null);
  return dir;
}

function manifest(repoPath: string, port: number): Manifest {
  return buildManifest(
    {
      backend: runnableRepo(
        {
          start: 'node server.mjs',
          health: 'http://{host}:{port}/health',
          ports: [httpSlot(port)],
        },
        { repoPath },
      ),
    },
    { host: '127.0.0.1' },
  );
}

/** A manifest whose `db` service cannot start, so the start path rejects hermetically. */
function bogusManifest(repoPath: string): Manifest {
  return buildManifest(
    {
      db: runnableRepo(
        {
          start: 'karst-test-nonexistent-binary',
          health: 'http://{host}:{port}/health',
          ports: [httpSlot(4999)],
        },
        { repoPath },
      ),
    },
    { host: '127.0.0.1' },
  );
}

/** Insert a baseline row for the `db` service and return its id. */
function insertBaselineRow(
  store: Store,
  over: { cwd?: string | null; started_at?: string | null; status?: string } = {},
): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, started_at, cwd)
       VALUES (NULL, 'db', '127.0.0.1', 4999, 4242, ?, '/tmp/db.log', ?, ?)`,
    )
    .run(
      over.status ?? 'running',
      over.started_at ?? '2026-09-14T00:00:00.000Z',
      over.cwd ?? '/repo/.karst/baseline/db',
    );
  return Number(info.lastInsertRowid);
}

function facts(over: Partial<ProcessFacts> = {}): ProcessFacts {
  return {
    isAlive: () => true,
    liveCwd: () => null,
    processStartMs: () => null,
    ...over,
  };
}

describe('baseline pool', () => {
  let store: Store;
  let repo: string;
  let origin: string;
  let noRemote: string;
  let nonGitDir: string;
  const started: number[] = [];

  beforeAll(async () => {
    // Ceiling keeps this probe inside the suite's own band [48400, 48600) so
    // a blocked window THROWS loudly ("leaked servers") rather than sliding
    // into supervisor's or spin.integration's band and drawing the same ports.
    portCounter = await freePortWindow(20, portCounter, 48600);
  });
  beforeEach(() => {
    store = openStore(':memory:');
    ({ repo, origin } = makeRepo());
    noRemote = makeRepoWithoutRemote();
    nonGitDir = mkdtempSync(join(tmpdir(), 'karst-nongit-'));
  });
  afterEach(async () => {
    for (const id of started.splice(0)) await stopServer(store, id);
    store.close();
    // Retried: the baseline servers stopped just above ran with the baseline
    // worktree as cwd, which Windows keeps pinned briefly after they die.
    removeTempDir(repo);
    removeTempDir(origin);
    removeTempDir(noRemote);
    removeTempDir(nonGitDir);
  });

  it('starts the baseline from baselineBranch (develop), not the current checkout [H4]', async () => {
    const port = portCounter++;
    const rec = await ensureBaseline(store, manifest(repo, port), 'backend');
    started.push(rec.id);

    expect(rec.ticketId).toBeNull(); // baseline singleton
    expect(rec.port).toBe(port); // default port
    expect(rec.status).toBe('running');

    // the served code is develop's, even though the repo checkout is `feature`
    const marker = await (await fetch(`http://127.0.0.1:${port}/marker`)).text();
    expect(marker.trim()).toBe('develop');

    const dir = join(repo, '.karst', 'baseline', 'backend');
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(
      git(repo, 'rev-parse', 'origin/develop').trim(),
    );
  });

  it('creates the baseline checkout detached at origin/develop', async () => {
    const port = portCounter++;
    const rec = await ensureBaseline(store, manifest(repo, port), 'backend');
    started.push(rec.id);

    const dir = join(repo, '.karst', 'baseline', 'backend');
    const symbolic = spawnSync('git', ['-C', dir, 'symbolic-ref', '-q', 'HEAD'], {
      encoding: 'utf8',
    });
    expect(symbolic.status).not.toBe(0);
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(
      git(repo, 'rev-parse', 'origin/develop').trim(),
    );
  });

  it('leaves the local base branch free for pullBase', async () => {
    const port = portCounter++;
    const rec = await ensureBaseline(store, manifest(repo, port), 'backend');
    started.push(rec.id);

    const porcelain = git(repo, 'worktree', 'list', '--porcelain');
    expect(porcelain).not.toContain('branch refs/heads/develop');
    git(repo, 'checkout', 'develop');
  });

  it('recuts a baseline directory git no longer knows', async () => {
    const port = portCounter++;
    const rec = await ensureBaseline(store, manifest(repo, port), 'backend');
    started.push(rec.id);

    const dir = join(repo, '.karst', 'baseline', 'backend');
    await stopServer(store, rec.id);
    git(repo, 'worktree', 'remove', '--force', dir);
    mkdirSync(dir, { recursive: true });
    expect(worktreeRegisteredAt(repo, dir)).toBe(false);

    const second = await ensureBaseline(store, manifest(repo, port), 'backend');
    started.push(second.id);

    expect(worktreeRegisteredAt(repo, dir)).toBe(true);
  });

  it('refreshes the baseline checkout to the new origin tip on start', async () => {
    const port = portCounter++;
    const rec = await ensureBaseline(store, manifest(repo, port), 'backend');
    started.push(rec.id);

    const dir = join(repo, '.karst', 'baseline', 'backend');
    const before = git(dir, 'rev-parse', 'HEAD').trim();

    git(repo, 'checkout', '-q', 'develop');
    writeFileSync(join(repo, 'marker.txt'), 'develop-2\n');
    git(repo, 'add', 'marker.txt');
    git(repo, 'commit', '-q', '-m', 'develop-2');
    git(repo, 'push', '-q', 'origin', 'develop');
    git(repo, 'checkout', '-q', 'feature');
    const tip = git(repo, 'rev-parse', 'origin/develop').trim();
    expect(tip).not.toBe(before);

    await stopServer(store, rec.id);
    const second = await ensureBaseline(store, manifest(repo, port), 'backend');
    started.push(second.id);

    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(tip);
  });

  it('does NOT force-refresh while another window holds the start lock [cross-window]', async () => {
    const port = portCounter++;
    const m = manifest(repo, port);
    const first = await ensureBaseline(store, m, 'backend');
    started.push(first.id);
    const dir = join(repo, '.karst', 'baseline', 'backend');
    const before = git(dir, 'rev-parse', 'HEAD').trim();

    // Retire OUR baseline, then advance origin/develop so a refresh WOULD move
    // the checkout — the exact state a second window's baseline could be serving
    // (its row is not written until its health gate passes, and its port may not
    // be bound yet, so neither a row nor a port probe could see it).
    await stopServer(store, first.id);
    git(repo, 'checkout', '-q', 'develop');
    writeFileSync(join(repo, 'marker.txt'), 'develop-2\n');
    git(repo, 'add', 'marker.txt');
    git(repo, 'commit', '-q', '-m', 'develop-2');
    git(repo, 'push', '-q', 'origin', 'develop');
    git(repo, 'checkout', '-q', 'feature');
    expect(git(repo, 'rev-parse', 'origin/develop').trim()).not.toBe(before);

    // A LIVE DIFFERENT process holds the start lock (`process.ppid` stands in).
    // `lockWaitMs: 0` bounds the wait so a lock whose owner never publishes a row
    // gives up at once (the default budget is 90s).
    const lockPath = join(repo, '.karst', 'baseline', 'backend.starting');
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    try {
      await expect(
        ensureBaseline(store, m, 'backend', { lockWaitMs: 0 }),
      ).rejects.toThrow(/another window/);
    } finally {
      rmSync(lockPath, { force: true });
    }

    // The checkout was NOT rewritten out from under the other window.
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(before);
  });

  it("waits for another window's in-flight start and ADOPTS the row it publishes [cross-window]", async () => {
    const checkout = join(repo, '.karst', 'baseline', 'db');
    mkdirSync(checkout, { recursive: true });
    // The row is not `running` yet: the other window publishes it at its health
    // gate, and THAT is what this window waits for instead of failing its spin.
    const id = insertBaselineRow(store, { cwd: checkout, status: 'stopped' });
    const lockPath = join(repo, '.karst', 'baseline', 'db.starting');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));

    let published = false;
    const rec = await ensureBaseline(store, bogusManifest(repo), 'db', {
      lockWaitMs: 10_000,
      sleep: async () => {
        if (published) return;
        published = true;
        store.db.prepare("UPDATE servers SET status = 'running' WHERE id = ?").run(id);
      },
      facts: facts({
        isAlive: () => true,
        liveCwd: () => ({ path: checkout, deleted: false }),
      }),
    });
    rmSync(lockPath, { force: true });

    expect(rec.id).toBe(id); // the other window's singleton, not a rival start
  });

  it('takes over a STALE start lock left by a dead window', async () => {
    const port = portCounter++;
    const m = manifest(repo, port);

    const lockPath = join(repo, '.karst', 'baseline', 'backend.starting');
    mkdirSync(dirname(lockPath), { recursive: true });
    // A pid the OS cannot have handed out: the owner is gone, the lock is stale.
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, startedAt: Date.now() }));

    const rec = await ensureBaseline(store, m, 'backend');
    started.push(rec.id);
    expect(rec.status).toBe('running');
  });

  it('releases the start lock after a successful start', async () => {
    const port = portCounter++;
    const rec = await ensureBaseline(store, manifest(repo, port), 'backend');
    started.push(rec.id);

    expect(existsSync(join(repo, '.karst', 'baseline', 'backend.starting'))).toBe(false);
  });

  it('reuses the running baseline on a second call (no double-start)', async () => {
    const port = portCounter++;
    const m = manifest(repo, port);
    const first = await ensureBaseline(store, m, 'backend');
    started.push(first.id);
    const checkout = join(repo, '.karst', 'baseline', 'backend');
    const second = await ensureBaseline(store, m, 'backend', {
      facts: facts({ liveCwd: () => ({ path: checkout, deleted: false }) }),
    });

    expect(second.pid).toBe(first.pid); // same process
    expect(second.id).toBe(first.id);
    const rows = store.db
      .prepare("SELECT COUNT(*) AS n FROM servers WHERE repo = 'backend' AND status = 'running'")
      .get() as { n: number };
    expect(rows.n).toBe(1); // exactly one baseline
  });

  it('reuses an attributable baseline row', async () => {
    const checkout = join(repo, '.karst', 'baseline', 'db');
    mkdirSync(checkout, { recursive: true });
    const id = insertBaselineRow(store, { cwd: checkout });
    const rec = await ensureBaseline(store, bogusManifest(repo), 'db', {
      facts: facts({
        isAlive: () => true,
        liveCwd: () => ({ path: checkout, deleted: false }),
      }),
    });

    expect(rec.pid).toBe(4242);
    const rows = store.db
      .prepare("SELECT COUNT(*) AS n FROM servers WHERE repo = 'db'")
      .get() as { n: number };
    expect(rows.n).toBe(1); // no new row inserted
    const row = store.db
      .prepare('SELECT status, pid FROM servers WHERE id = ?')
      .get(id) as { status: string; pid: number | null };
    expect(row).toEqual({ status: 'running', pid: 4242 });
  });

  it('reuses a running baseline whose live cwd is a SUBDIRECTORY of the checkout', async () => {
    // A start command that `cd`s into a subdirectory (or an app that calls
    // `process.chdir`) leaves the live cwd a CHILD of the recorded checkout.
    // `attributeServer` compares for equality, so it reads as `foreign` — but the
    // checkout is baseline-owned and the process is ours. Retiring it here would
    // kill the shared singleton on every dependent spin.
    const checkout = join(repo, '.karst', 'baseline', 'db');
    mkdirSync(join(checkout, 'node_modules'), { recursive: true });
    const id = insertBaselineRow(store, { cwd: checkout });
    const rec = await ensureBaseline(store, bogusManifest(repo), 'db', {
      facts: facts({
        isAlive: () => true,
        liveCwd: () => ({ path: join(checkout, 'node_modules'), deleted: false }),
      }),
    });

    expect(rec.id).toBe(id);
    const row = store.db
      .prepare('SELECT status FROM servers WHERE id = ?')
      .get(id) as { status: string };
    expect(row.status).toBe('running'); // reused, not retired
  });

  it('retires a running row whose checkout was REMOVED, so it is recut', async () => {
    // The pid attributes, but the directory is gone (a hand-run `git worktree
    // remove`, an `rm -rf`). Handing the row back serves a deleted tree forever;
    // retiring it makes the caller recut.
    const id = insertBaselineRow(store, { cwd: join(nonGitDir, '.karst', 'baseline', 'db') });
    await expect(
      ensureBaseline(store, bogusManifest(nonGitDir), 'db', {
        facts: facts({ isAlive: () => true, liveCwd: () => null }),
      }),
    ).rejects.toThrow();

    const row = store.db
      .prepare('SELECT status FROM servers WHERE id = ?')
      .get(id) as { status: string };
    expect(row.status).toBe('stopped'); // retired, not reused
  });

  it('resolves ASYNC process probes on the reuse path (never blocks the host)', async () => {
    // The spin path runs on the extension host's single event loop, so the reuse
    // attribution must go through the async probes (like `stopServer` and
    // `reclaimPort`), never a `spawnSync('ps')`. An async source whose probes
    // resolve on a later tick must still attribute and reuse the row.
    const checkout = join(repo, '.karst', 'baseline', 'db');
    mkdirSync(checkout, { recursive: true });
    const id = insertBaselineRow(store, { cwd: checkout });
    const source: ProcessFactsSource = {
      isAlive: () => Promise.resolve(true),
      liveCwd: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { path: checkout, deleted: false };
      },
      processStartMs: () => Promise.resolve(null),
    };
    const rec = await ensureBaseline(store, bogusManifest(repo), 'db', { facts: source });

    expect(rec.pid).toBe(4242);
    const row = store.db
      .prepare('SELECT status, pid FROM servers WHERE id = ?')
      .get(id) as { status: string; pid: number | null };
    expect(row).toEqual({ status: 'running', pid: 4242 });
  });

  it('emits injected debug lines at baseline decision points', async () => {
    insertBaselineRow(store);
    const debug: string[] = [];
    await expect(
      ensureBaseline(store, bogusManifest(nonGitDir), 'db', {
        facts: facts({ isAlive: () => false }),
        debug: (line) => debug.push(line),
      }),
    ).rejects.toThrow();

    expect(debug.some((line) => line.includes("is 'dead'"))).toBe(true);
  });

  it('retires a dead baseline row and starts fresh', async () => {
    const id = insertBaselineRow(store);
    await expect(
      ensureBaseline(store, bogusManifest(nonGitDir), 'db', { facts: facts({ isAlive: () => false }) }),
    ).rejects.toThrow();

    const row = store.db
      .prepare('SELECT status, pid FROM servers WHERE id = ?')
      .get(id) as { status: string; pid: number | null };
    expect(row).toEqual({ status: 'stopped', pid: null });
  });

  it('retires a foreign (reissued-pid) baseline row', async () => {
    const id = insertBaselineRow(store);
    await expect(
      ensureBaseline(store, bogusManifest(nonGitDir), 'db', {
        facts: facts({
          isAlive: () => true,
          liveCwd: () => ({ path: '/some/other/place', deleted: false }),
        }),
      }),
    ).rejects.toThrow();

    const row = store.db
      .prepare('SELECT status, pid FROM servers WHERE id = ?')
      .get(id) as { status: string; pid: number | null };
    expect(row).toEqual({ status: 'stopped', pid: null });
  });

  it('reuses a baseline row when attribution is undecidable (unknown)', async () => {
    // Windows (no `ps` start time, no cwd probe) is the real case: the process
    // is alive, but no probe can prove it. Retiring here would kill a working
    // shared baseline on every spin, so `unknown` must not retire.
    const checkout = join(repo, '.karst', 'baseline', 'db');
    mkdirSync(checkout, { recursive: true });
    const id = insertBaselineRow(store, { cwd: checkout });
    const rec = await ensureBaseline(store, bogusManifest(repo), 'db', {
      facts: facts({ isAlive: () => true, liveCwd: () => null, processStartMs: () => null }),
    });

    expect(rec.pid).toBe(4242);
    const row = store.db
      .prepare('SELECT status, pid FROM servers WHERE id = ?')
      .get(id) as { status: string; pid: number | null };
    expect(row).toEqual({ status: 'running', pid: 4242 });
  });

  it('retires a running row with no pid (a crash remnant)', async () => {
    const info = store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd)
         VALUES (NULL, 'db', '127.0.0.1', 4999, NULL, 'running', '/tmp/db.log', NULL)`,
      )
      .run();
    const id = Number(info.lastInsertRowid);

    await expect(
      ensureBaseline(store, bogusManifest(nonGitDir), 'db', { facts: facts({ isAlive: () => true }) }),
    ).rejects.toThrow();

    const row = store.db
      .prepare('SELECT status, pid FROM servers WHERE id = ?')
      .get(id) as { status: string; pid: number | null };
    expect(row).toEqual({ status: 'stopped', pid: null });
  });

  it('starts a baseline from the local branch when the repo has no origin', async () => {
    const port = portCounter++;
    const rec = await ensureBaseline(store, manifest(noRemote, port), 'backend');
    started.push(rec.id);

    expect(rec.status).toBe('running');
    const marker = await (await fetch(`http://127.0.0.1:${port}/marker`)).text();
    expect(marker.trim()).toBe('develop'); // the local develop branch's code

    const dir = join(noRemote, '.karst', 'baseline', 'backend');
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(
      git(noRemote, 'rev-parse', 'develop').trim(),
    );
  });

  it('shares one in-flight baseline start between concurrent callers', async () => {
    const m = bogusManifest(repo);
    const debug: string[] = [];
    const a = ensureBaseline(store, m, 'db', { debug: (line) => debug.push(line) });
    const b = ensureBaseline(store, m, 'db', { debug: (line) => debug.push(line) });
    const settled = await Promise.allSettled([a, b]);

    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    const rows = store.db
      .prepare("SELECT COUNT(*) AS n FROM servers WHERE repo = 'db'")
      .get() as { n: number };
    expect(rows.n).toBe(1); // one failed row — one start, not two
    // The second same-window caller shares the first's start (never trips the lock).
    expect(debug.some((line) => line.includes('sharing the in-flight start'))).toBe(true);
  });

  it('addBaselineRef records the ledger edge', () => {
    addBaselineRef(store, 5, 'backend');
    const row = store.db
      .prepare('SELECT ticket_id, repo FROM baseline_refs WHERE ticket_id = ? AND repo = ?')
      .get(5, 'backend') as { ticket_id: number; repo: string } | undefined;
    expect(row).toEqual({ ticket_id: 5, repo: 'backend' });
  });

  it('addBaselineRef is idempotent (PK on ticket+repo)', () => {
    addBaselineRef(store, 5, 'backend');
    addBaselineRef(store, 5, 'backend');
    const n = store.db
      .prepare('SELECT COUNT(*) AS n FROM baseline_refs WHERE ticket_id = 5')
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});
