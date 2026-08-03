import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import {
  startHot,
  stopServer,
  stopTicketServers,
  pruneOrphanServers,
  tailLog,
} from './supervisor.js';
import { freePortWindow, removeTempDir } from './fixtures.js';

/**
 * A fixture dev server: comes up on PORT, serves /health 200 only after a delay
 * so the test proves start() waits for health, not just for spawn.
 */
const SERVER_SRC = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
const readyAfter = Number(process.env.READY_AFTER_MS || '0');
const start = Date.now();
console.log('booting on ' + port);
createServer((req, res) => {
  if (req.url === '/health') {
    if (Date.now() - start < readyAfter) { res.writeHead(503); res.end('warming'); return; }
    res.writeHead(200); res.end('ok');
    return;
  }
  res.writeHead(404); res.end();
}).listen(port);
`;

/** A server that binds but never returns healthy — to exercise the timeout path. */
const NEVER_HEALTHY_SRC = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
createServer((_req, res) => { res.writeHead(503); res.end('never'); }).listen(port);
`;

/**
 * A launcher that forks a long-lived grandchild (like `npm run dev` → Vite),
 * writes the grandchild pid to GRANDCHILD_PID_FILE, and itself never gets
 * healthy — to prove killTree reaps the grandchild, not just the launcher.
 */
const LAUNCHER_SRC = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grand = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { stdio: 'ignore' });
writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grand.pid));
// never bind a health port — startHot will time out and kill us
setInterval(() => {}, 1e9);
`;

/** Poll `url` until it answers 200, so a fixture is provably up before the test acts. */
async function waitUntilServing(url: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`fixture never served ${url}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** True if pid is alive (signal 0 probes without killing). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let portCounter = 48200;
function nextPort(): number {
  return portCounter++;
}

describe('server supervisor', () => {
  let store: Store;
  let dir: string;

  beforeAll(async () => {
    portCounter = await freePortWindow(40, portCounter);
  });
  beforeEach(() => {
    store = openStore(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'karst-sup-'));
    writeFileSync(join(dir, 'server.mjs'), SERVER_SRC);
    writeFileSync(join(dir, 'never.mjs'), NEVER_HEALTHY_SRC);
    writeFileSync(join(dir, 'launcher.mjs'), LAUNCHER_SRC);
  });
  afterEach(() => {
    // Any server a case left running is a detached process that OUTLIVES vitest and
    // keeps its port — the next run then finds a foreign listener on a fixture port
    // and fails somewhere unrelated. Sweep, don't rely on each case to kill.
    for (const s of store.db.prepare("SELECT id FROM servers WHERE status='running'").all()) {
      stopServer(store, (s as { id: number }).id);
    }
    store.close();
    // Retried: every server here is spawned with `cwd: dir`, and on Windows that
    // pins the directory for a few tens of milliseconds after the process dies.
    removeTempDir(dir);
  });

  // A manifest naming a tool the machine doesn't have (`docker compose up` with
  // no docker) is the one dependency class karst cannot preflight — the commands
  // are arbitrary user strings. So the failure has to explain itself here.
  //
  // Node emits ENOENT as an ASYNC 'error' event, and an 'error' event with no
  // listener throws. Unhandled, this landed as an uncaught exception in the
  // extension host, from a stack that named neither the service nor the command.
  it('a command that is not installed rejects with the command name, and never throws unhandled', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (e: Error): void => void uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const port = nextPort();
      await expect(
        startHot(store, {
          ticketId: 1,
          service: 'backend',
          command: 'karst-no-such-binary',
          args: ['up'],
          cwd: dir,
          env: {},
          host: '127.0.0.1',
          port,
          healthUrl: `http://127.0.0.1:${port}/health`,
          logPath: join(dir, 'svc.log'),
        }),
      ).rejects.toThrow(/karst-no-such-binary/);

      // The 'error' event fires a tick after spawn returns; give it room to land.
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('names the service, so the user knows which manifest entry is wrong', async () => {
    const port = nextPort();
    await expect(
      startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: 'karst-no-such-binary',
        args: [],
        cwd: dir,
        env: {},
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
      }),
    ).rejects.toThrow(/backend/);
  });

  it('startHot resolves only after health passes and records the server row', async () => {
    const port = nextPort();
    const logPath = join(dir, 'svc.log');
    const rec = await startHot(store, {
      ticketId: 1,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      env: { PORT: String(port), READY_AFTER_MS: '400' },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath,
    });

    expect(rec.pid).toBeGreaterThan(0);
    expect(rec.port).toBe(port);
    expect(rec.status).toBe('running');
    expect(rec.logPath).toBe(logPath);

    // health must actually be OK by the time startHot resolves
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);

    const row = store.db
      .prepare('SELECT pid, port, status, log_path, cwd FROM servers WHERE id = ?')
      .get(rec.id) as {
      pid: number;
      port: number;
      status: string;
      log_path: string;
      cwd: string | null;
    };
    expect(row.status).toBe('running');
    expect(row.pid).toBe(rec.pid);
    // The directory is what ties this pid to the tree it serves: removing that
    // tree reaps the process, and a boot sweep can spot one whose tree is gone.
    // Without it a removed worktree leaves a detached server running forever.
    expect(row.cwd).toBe(dir);

    stopServer(store, rec.id);
  });

  it('stopServer kills the process and sets status=stopped', async () => {
    const port = nextPort();
    const rec = await startHot(store, {
      ticketId: 1,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath: join(dir, 'svc.log'),
    });

    stopServer(store, rec.id);

    // Row RETAINED as offline (stopped, pid nulled) so the dashboard can show it
    // and offer a restart — not deleted.
    const row = store.db.prepare('SELECT status, pid FROM servers WHERE id = ?').get(rec.id) as
      | { status: string; pid: number | null }
      | undefined;
    expect(row?.status).toBe('stopped');
    expect(row?.pid).toBeNull();

    // port should be free again shortly after kill
    await new Promise((r) => setTimeout(r, 200));
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toBeTruthy();
  });

  it('startHot replaces a prior stopped row for the same ticket+service (no dup)', async () => {
    const port1 = nextPort();
    const rec = await startHot(store, {
      ticketId: 5,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      env: { PORT: String(port1) },
      host: '127.0.0.1',
      port: port1,
      healthUrl: `http://127.0.0.1:${port1}/health`,
      logPath: join(dir, 'svc.log'),
    });
    stopServer(store, rec.id); // retained as offline

    const port2 = nextPort();
    const rec2 = await startHot(store, {
      ticketId: 5,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      env: { PORT: String(port2) },
      host: '127.0.0.1',
      port: port2,
      healthUrl: `http://127.0.0.1:${port2}/health`,
      logPath: join(dir, 'svc2.log'),
    });

    // Only the fresh running row remains for (ticket 5, backend) — the stopped
    // one was replaced, not accumulated.
    const rows = store.db
      .prepare("SELECT id, status FROM servers WHERE ticket_id = 5 AND repo = 'backend'")
      .all() as { id: number; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(rec2.id);
    expect(rows[0]!.status).toBe('running');

    stopServer(store, rec2.id);
  });

  it('rejects after a timeout when the service never gets healthy', async () => {
    const port = nextPort();
    await expect(
      startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'never.mjs')],
        cwd: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
        healthTimeoutMs: 1200,
      }),
    ).rejects.toThrow(/health|timeout/i);
  });

  // A foreign process on the port answers /health, so health alone cannot tell
  // "my service is up" from "somebody else's is". Our own child meanwhile dies of
  // EADDRINUSE, and startHot used to record its dead pid as status='running' —
  // the dashboard then showed a healthy server nothing could stop or restart.
  it('rejects when its own process dies of a port conflict instead of adopting the foreign listener', async () => {
    const port = nextPort();
    const foreign = spawn(process.execPath, [join(dir, 'server.mjs')], {
      cwd: dir,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    try {
      await waitUntilServing(`http://127.0.0.1:${port}/health`);

      await expect(
        startHot(store, {
          ticketId: 1,
          service: 'backend',
          command: process.execPath,
          args: [join(dir, 'server.mjs')],
          cwd: dir,
          env: { PORT: String(port) },
          host: '127.0.0.1',
          port,
          healthUrl: `http://127.0.0.1:${port}/health`,
          logPath: join(dir, 'svc.log'),
          healthTimeoutMs: 5_000,
        }),
      ).rejects.toThrow(/backend/);

      const rows = store.db.prepare('SELECT COUNT(*) AS n FROM servers').get() as { n: number };
      expect(rows.n).toBe(0); // nothing recorded as running
    } finally {
      foreign.kill('SIGKILL');
    }
  });

  it('kills the grandchild when a launcher fails health (no orphan)', async () => {
    const port = nextPort();
    const pidFile = join(dir, 'grandchild.pid');
    await expect(
      startHot(store, {
        ticketId: 1,
        service: 'frontend',
        command: process.execPath,
        args: [join(dir, 'launcher.mjs')],
        cwd: dir,
        env: { PORT: String(port), GRANDCHILD_PID_FILE: pidFile },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
        healthTimeoutMs: 800,
      }),
    ).rejects.toThrow(/health|timeout/i);

    const grandPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(grandPid).toBeGreaterThan(0);
    // Give the group-kill a moment to propagate.
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(grandPid)).toBe(false); // grandchild reaped, not orphaned
  });

  it('aborts a health-gated start promptly when the signal fires', async () => {
    const port = nextPort();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    const start = Date.now();
    await expect(
      startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'never.mjs')],
        cwd: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
        healthTimeoutMs: 30_000,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(Date.now() - start).toBeLessThan(3_000); // aborted, not timed out
  });

  it('stopTicketServers kills every running server of a ticket (retained offline), leaves others', async () => {
    const mk = async (ticketId: number) => {
      const port = nextPort();
      return startHot(store, {
        ticketId,
        service: `svc-${port}`,
        command: process.execPath,
        args: [join(dir, 'server.mjs')],
        cwd: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, `svc-${port}.log`),
      });
    };
    const a = await mk(7);
    const b = await mk(7);
    const other = await mk(9);

    stopTicketServers(store, 7);

    const row = (id: number) =>
      store.db.prepare('SELECT status FROM servers WHERE id = ?').get(id) as
        | { status: string }
        | undefined;
    expect(row(a.id)?.status).toBe('stopped'); // retained as offline
    expect(row(b.id)?.status).toBe('stopped'); // retained as offline
    expect(row(other.id)?.status).toBe('running'); // untouched — different ticket

    await new Promise((r) => setTimeout(r, 200));
    expect(alive(a.pid)).toBe(false);
    expect(alive(b.pid)).toBe(false);
    expect(alive(other.pid)).toBe(true);

    stopServer(store, other.id);
  });

  it('writes stdout/stderr to the log file (tailLog reads it)', async () => {
    const port = nextPort();
    const logPath = join(dir, 'svc.log');
    const rec = await startHot(store, {
      ticketId: 1,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath,
    });

    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toMatch(/booting on/);
    expect(tailLog(rec)).toMatch(/booting on/);

    stopServer(store, rec.id);
  });

  // Logs live in a subdirectory now (`<cwd>/.karst/logs/`, which git is told to
  // ignore) rather than at the working-tree root, and a fresh worktree has no
  // such directory. `openSync` on a missing parent is ENOENT, so the server that
  // was about to start would fail to start at all.
  it('creates the log directory when it does not exist yet', async () => {
    const port = nextPort();
    const logPath = join(dir, '.karst', 'logs', 'svc.log');
    expect(existsSync(join(dir, '.karst', 'logs'))).toBe(false);

    const rec = await startHot(store, {
      ticketId: 1,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath,
    });

    expect(readFileSync(logPath, 'utf8')).toMatch(/booting on/);

    stopServer(store, rec.id);
  });
});

describe('pruneOrphanServers', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  /** Insert a server row directly — no process; only the row shape matters here. */
  function row(ticketId: number | null, repo: string, status: string): number {
    const info = store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path)
         VALUES (?, ?, '127.0.0.1', 3000, NULL, ?, '/tmp/x.log')`,
      )
      .run(ticketId, repo, status);
    return Number(info.lastInsertRowid);
  }

  const exists = (id: number): boolean =>
    store.db.prepare('SELECT id FROM servers WHERE id = ?').get(id) !== undefined;

  it('deletes rows naming a repository the manifest no longer declares', () => {
    const renamed = row(7, 'backend', 'stopped'); // manifest key gone (renamed to BE)
    const kept = row(7, 'BE', 'running');

    pruneOrphanServers(store, 7, ['BE', 'FE']);

    expect(exists(renamed)).toBe(false);
    expect(exists(kept)).toBe(true);
  });

  it('keeps a stopped row whose repository still exists (deselected, not renamed)', () => {
    const offline = row(7, 'FE', 'stopped');

    pruneOrphanServers(store, 7, ['BE', 'FE']);

    expect(exists(offline)).toBe(true);
  });

  it('touches neither another ticket nor a baseline row', () => {
    const otherTicket = row(9, 'backend', 'stopped');
    const baseline = row(null, 'backend', 'running');

    pruneOrphanServers(store, 7, ['BE']);

    expect(exists(otherTicket)).toBe(true);
    expect(exists(baseline)).toBe(true);
  });

  it('with no known repositories, reaps every row of the ticket', () => {
    const a = row(7, 'backend', 'stopped');
    const baseline = row(null, 'backend', 'running');

    pruneOrphanServers(store, 7, []);

    expect(exists(a)).toBe(false);
    expect(exists(baseline)).toBe(true);
  });
});
