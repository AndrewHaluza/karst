import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { freePortWindow, removeTempDir } from './fixtures.js';
import { stopServer } from './supervisor.js';
import { ensureBaseline, addBaselineRef } from './baseline.js';
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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-base-'));
  writeFileSync(join(dir, 'server.mjs'), SERVER_SRC);
  writeFileSync(join(dir, 'marker.txt'), 'develop\n');
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 't@k.local');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'develop');
  // a feature branch that CHANGES the marker + is left checked out
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'marker.txt'), 'feature\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'feature');
  // repo's current checkout is now `feature`, NOT develop
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

describe('baseline pool', () => {
  let store: Store;
  let repo: string;
  const started: number[] = [];

  beforeAll(async () => {
    // Ceiling keeps this probe inside the suite's own band [48400, 48600) so
    // a blocked window THROWS loudly ("leaked servers") rather than sliding
    // into supervisor's or spin.integration's band and drawing the same ports.
    portCounter = await freePortWindow(20, portCounter, 48600);
  });
  beforeEach(() => {
    store = openStore(':memory:');
    repo = makeRepo();
  });
  afterEach(async () => {
    for (const id of started.splice(0)) await stopServer(store, id);
    store.close();
    // Retried: the baseline servers stopped just above ran with the baseline
    // worktree as cwd, which Windows keeps pinned briefly after they die.
    removeTempDir(repo);
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
  });

  it('reuses the running baseline on a second call (no double-start)', async () => {
    const port = portCounter++;
    const m = manifest(repo, port);
    const first = await ensureBaseline(store, m, 'backend');
    started.push(first.id);
    const second = await ensureBaseline(store, m, 'backend');

    expect(second.pid).toBe(first.pid); // same process
    expect(second.id).toBe(first.id);
    const rows = store.db
      .prepare("SELECT COUNT(*) AS n FROM servers WHERE repo = 'backend' AND status = 'running'")
      .get() as { n: number };
    expect(rows.n).toBe(1); // exactly one baseline
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
