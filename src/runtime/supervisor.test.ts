import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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
  abandonVerdict,
} from './supervisor.js';
import { freePortWindow, removeTempDir, waitUntilListening } from './fixtures.js';
import { listenerPids } from './portConflict.js';
import { killTree } from './processTree.js';
import { removeContainer, removeContainerAsync } from './dockerContainer.js';

// Container removal really spawns `docker`; stub it so these cases assert the
// contract (which name, and when) without a docker daemon on the machine.
vi.mock('./dockerContainer.js', () => ({
  removeContainer: vi.fn(),
  removeContainerAsync: vi.fn(async () => {}),
}));
const removeContainerMock = vi.mocked(removeContainer);
const removeContainerAsyncMock = vi.mocked(removeContainerAsync);

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

/**
 * A server that binds but never returns healthy — to exercise the timeout path.
 */
const NEVER_HEALTHY_SRC = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
createServer((_req, res) => { res.writeHead(503); res.end('never'); }).listen(port);
`;

/**
 * The reported squatter: a dev server that binds its hardcoded port and answers
 * NOTHING the health URL asks (a plain FE dev server 404s /health). It occupies
 * the port without ever being "serving", so the health probe cannot see it and
 * a spawned child dies of EADDRINUSE.
 */
const DEAF_SERVER_SRC = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
createServer((_req, res) => { res.writeHead(404); res.end(); }).listen(port);
`;

/** A server that answers ONLY its own health path — 404s every other URL. */
const CUSTOM_HEALTH_SRC = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
const healthPath = process.env.HEALTH_PATH;
createServer((req, res) => {
  if (req.url === healthPath) { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
}).listen(port);
`;

/**
 * A service that dies immediately with a distinctive stderr message — the
 * `MODULE_NOT_FOUND`-style failure this suite reports. The spin error must
 * surface this output, not just "the process exited with code 1".
 */
const EXIT_BOOT_SRC = `
console.error('Cannot find module server.mjs');
process.exit(1);
`;

/**
 * A service that writes more output than the surfaced log tail may carry, then
 * dies — to prove the tail is BOUNDED and marks its own truncation.
 */
const HUGE_EXIT_SRC = `
for (let i = 0; i < 5000; i++) console.error('filler line ' + i);
console.error('the real error at the very end');
process.exit(1);
`;

/**
 * A service that prints its own reason to the log, then never becomes healthy —
 * to prove the health-timeout error carries the log tail too.
 */
const STUCK_WITH_OUTPUT_SRC = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
console.error('listening on 1337, not the allocated ' + port);
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

/**
 * A launcher that exits 0 having started nothing — the `docker compose up -d`
 * shape when the daemonised process it was supposed to leave behind died (or
 * was never started). Nothing is left to become healthy, yet the health gate
 * waited out its whole deadline before saying so.
 */
const EXIT_ZERO_SRC = `
console.error('nothing to run here');
process.exit(0);
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

// The abandoned-start decision, as a table. The loop that drives it polls a
// real port and a real process group; the RULE is what matters, and it differs
// per platform because only POSIX can prove a process group is empty.
describe('abandonVerdict', () => {
  it('lets health decide as soon as something is listening', () => {
    for (const group of ['alive', 'empty', 'unknown'] as const) {
      for (const graceElapsed of [false, true]) {
        expect(abandonVerdict({ portOpen: true, group, graceElapsed })).toBe('serving');
      }
    }
  });

  it('gives an empty group the daemonise grace before abandoning', () => {
    // An empty group is NOT proof that nothing was left behind: a launcher
    // that detaches its daemon (`spawn(..., { detached: true }).unref()`,
    // `docker compose up -d`) leaves an empty group of its own while the
    // daemon — in another group entirely — is still binding the port. Inside
    // the grace the answer is "wait"; the fast failure lands the moment it
    // elapses, which still beats the health deadline by 28 seconds.
    expect(abandonVerdict({ portOpen: false, group: 'empty', graceElapsed: false })).toBe('wait');
    expect(abandonVerdict({ portOpen: false, group: 'empty', graceElapsed: true })).toBe(
      'abandoned',
    );
  });

  it('keeps waiting while the group still has processes in it', () => {
    expect(abandonVerdict({ portOpen: false, group: 'alive', graceElapsed: false })).toBe('wait');
  });

  it('hands a still-populated group back to health once the grace is over', () => {
    expect(abandonVerdict({ portOpen: false, group: 'alive', graceElapsed: true })).toBe('serving');
  });

  // The reported regression: on Windows a process group cannot be probed at
  // all, so treating "cannot tell" as "empty" failed every daemonising launcher
  // one poll after it exited — the grace period existed but never applied.
  it('waits out the whole grace when the group cannot be probed (Windows)', () => {
    expect(abandonVerdict({ portOpen: false, group: 'unknown', graceElapsed: false })).toBe('wait');
  });

  it('abandons an unprobeable group only after the grace has elapsed', () => {
    expect(abandonVerdict({ portOpen: false, group: 'unknown', graceElapsed: true })).toBe(
      'abandoned',
    );
  });
});

describe('server supervisor', () => {
  let store: Store;
  let dir: string;

  beforeAll(async () => {
    // Ceiling keeps this probe inside the suite's own band [48200, 48400) so
    // a blocked window THROWS loudly ("leaked servers") rather than sliding
    // into baseline's or spin.integration's band and drawing the same ports.
    portCounter = await freePortWindow(40, portCounter, 48400);
  });
  beforeEach(() => {
    store = openStore(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'karst-sup-'));
    writeFileSync(join(dir, 'server.mjs'), SERVER_SRC);
    writeFileSync(join(dir, 'never.mjs'), NEVER_HEALTHY_SRC);
    writeFileSync(join(dir, 'deaf.mjs'), DEAF_SERVER_SRC);
    writeFileSync(join(dir, 'custom.mjs'), CUSTOM_HEALTH_SRC);
    writeFileSync(join(dir, 'launcher.mjs'), LAUNCHER_SRC);
    writeFileSync(join(dir, 'exit.mjs'), EXIT_BOOT_SRC);
    writeFileSync(join(dir, 'huge-exit.mjs'), HUGE_EXIT_SRC);
    writeFileSync(join(dir, 'stuck.mjs'), STUCK_WITH_OUTPUT_SRC);
    writeFileSync(join(dir, 'exit-zero.mjs'), EXIT_ZERO_SRC);
  });
  afterEach(async () => {
    // Any server a case left running is a detached process that OUTLIVES vitest and
    // keeps its port — the next run then finds a foreign listener on a fixture port
    // and fails somewhere unrelated. Sweep, don't rely on each case to kill.
    for (const s of store.db.prepare("SELECT id FROM servers WHERE status='running'").all()) {
      await stopServer(store, (s as { id: number }).id);
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
          repoPath: dir,
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
        repoPath: dir,
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
      repoPath: dir,
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

    await stopServer(store, rec.id);
  });

  it('stopServer kills the process and sets status=stopped', async () => {
    const port = nextPort();
    const rec = await startHot(store, {
      ticketId: 1,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      repoPath: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath: join(dir, 'svc.log'),
    });

    await stopServer(store, rec.id);

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
      repoPath: dir,
      env: { PORT: String(port1) },
      host: '127.0.0.1',
      port: port1,
      healthUrl: `http://127.0.0.1:${port1}/health`,
      logPath: join(dir, 'svc.log'),
    });
    await stopServer(store, rec.id); // retained as offline

    const port2 = nextPort();
    const rec2 = await startHot(store, {
      ticketId: 5,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      repoPath: dir,
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

    await stopServer(store, rec2.id);
  });

  // The reported failure: a health gate that spends its whole deadline on a
  // process that is ALREADY GONE, then blames the health check. A launcher that
  // exits 0 is legitimately allowed to daemonise, so the exit alone proves
  // nothing — but once its process group is empty AND nothing is listening on
  // the port, there is nothing left that could ever become healthy.
  it('fails at once when a launcher exits leaving nothing listening, instead of waiting out the deadline', async () => {
    const port = nextPort();
    const started = Date.now();
    await expect(
      startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'exit-zero.mjs')],
        cwd: dir,
        repoPath: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
        healthTimeoutMs: 30_000,
      }),
    ).rejects.toThrow(/exited.*nothing (is )?listening|nothing (is )?listening/i);
    expect(Date.now() - started).toBeLessThan(15_000); // never waited out the 30s
  });

  // A launcher that exits 0 and DOES leave a healthy daemon behind must still
  // pass — the fast-fail must not turn daemonising into a failure.
  it('still accepts a launcher that exits 0 leaving a healthy process behind', async () => {
    const port = nextPort();
    writeFileSync(
      join(dir, 'daemonise.mjs'),
      `import { spawn } from 'node:child_process';
       spawn(process.execPath, [${JSON.stringify(join(dir, 'server.mjs'))}], {
         env: { ...process.env, PORT: String(${port}) },
         detached: true,
         stdio: 'ignore',
       }).unref();
       process.exit(0);`,
    );
    const rec = await startHot(store, {
      ticketId: 1,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'daemonise.mjs')],
      cwd: dir,
      repoPath: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath: join(dir, 'svc.log'),
      healthTimeoutMs: 10_000,
    });
    expect(rec.status).toBe('running');
    // The daemon outlives its launcher and this test's row, so reap it by port.
    const pids = await listenerPids('127.0.0.1', port);
    for (const pid of pids) killTree(pid);
  });

  // "health check <url> did not pass within 30000ms" is true and useless: it
  // names what karst watched, never what the port actually showed. The timeout
  // must say whether anything was listening at all — the difference between "my
  // service never bound" and "something else answers here".
  it('names the port state when the health check times out with nothing listening', async () => {
    const port = nextPort();
    let message = '';
    await startHot(store, {
      ticketId: 1,
      service: 'backend',
      command: process.execPath,
      // Alive, but never binds anything: the health URL can never pass.
      args: ['-e', 'setInterval(() => {}, 1e9)'],
      cwd: dir,
      repoPath: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath: join(dir, 'svc.log'),
      healthTimeoutMs: 1200,
    }).catch((err: Error) => {
      message = err.message;
    });
    expect(message).toMatch(/nothing is listening on 127\.0\.0\.1:/i);
  });

  it('reports the listener when the health check times out against an occupied port', async () => {
    const port = nextPort();
    let message = '';
    await startHot(store, {
      ticketId: 1,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'never.mjs')],
      cwd: dir,
      repoPath: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath: join(dir, 'svc.log'),
      healthTimeoutMs: 1500,
    }).catch((err: Error) => {
      message = err.message;
    });
    expect(message).toMatch(/something is listening on 127\.0\.0\.1:/i);
    expect(message).not.toMatch(/nothing is listening/i);
  });

  // Identity (`service.healthIdentity`). Reachability alone cannot tell "my
  // service came up" from "someone else's service holds this port" — the
  // reported wrong PASS, where a spin was greenlit against another worktree's
  // gateway and everything downstream was wired to it.
  describe('health identity', () => {
    /** Echoes the token karst put in the env — the contract a service keeps. */
    const ECHO_SRC = `
import { createServer } from 'node:http';
createServer((_req, res) => {
  res.writeHead(200, { 'x-karst-instance': process.env.KARST_INSTANCE_TOKEN ?? '' });
  res.end('ok');
}).listen(Number(process.env.PORT));
`;

    it('passes when the service echoes the token karst gave this start', async () => {
      const port = nextPort();
      writeFileSync(join(dir, 'echo.mjs'), ECHO_SRC);
      const rec = await startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'echo.mjs')],
        cwd: dir,
        repoPath: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
        requireIdentity: true,
        healthTimeoutMs: 8_000,
      });
      expect(rec.status).toBe('running');
      await stopServer(store, rec.id);
    });

    it('refuses a healthy 200 from a service that is not this start', async () => {
      const port = nextPort();
      // A foreign instance: 200 on /health, but its own token — precisely the
      // sibling worktree's server the port probe could not distinguish.
      writeFileSync(
        join(dir, 'foreign.mjs'),
        `import { createServer } from 'node:http';
         createServer((_q, res) => {
           res.writeHead(200, { 'x-karst-instance': 'some-other-start' });
           res.end('ok');
         }).listen(Number(process.env.PORT));`,
      );
      let message = '';
      await startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'foreign.mjs')],
        cwd: dir,
        repoPath: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
        requireIdentity: true,
        healthTimeoutMs: 8_000,
      }).catch((err: Error) => {
        message = err.message;
      });
      expect(message).toMatch(/another instance/i);
    });

    it('does not set the token, or check identity, when the service did not ask for it', async () => {
      const port = nextPort();
      // Answers 200 only when the env var is ABSENT: proves karst mints no token
      // for a service that never opted in.
      writeFileSync(
        join(dir, 'no-token.mjs'),
        `import { createServer } from 'node:http';
         createServer((_q, res) => {
           const leaked = process.env.KARST_INSTANCE_TOKEN;
           res.writeHead(leaked ? 500 : 200); res.end(leaked ?? 'ok');
         }).listen(Number(process.env.PORT));`,
      );
      const rec = await startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'no-token.mjs')],
        cwd: dir,
        repoPath: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
        healthTimeoutMs: 8_000,
      });
      expect(rec.status).toBe('running');
      await stopServer(store, rec.id);
    });
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
        repoPath: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
        healthTimeoutMs: 1200,
      }),
    ).rejects.toThrow(/health|timeout/i);
  });

  // The reported spin failure (869ecy81w follow-up): a service whose process
  // dies before it ever becomes healthy — e.g. `node server.mjs` where the file
  // does not exist — surfaced ONLY "the process exited with code 1 before it
  // became healthy. See the log: <path>", so the user had to open the log to
  // learn the actual reason (MODULE_NOT_FOUND). The error must now carry the
  // service's own output, bounded, so the cause is visible in the toast itself.
  it('surfaces the process log tail when the service exits before becoming healthy', async () => {
    const port = nextPort();
    await expect(
      startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'exit.mjs')],
        cwd: dir,
        repoPath: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
      }),
    ).rejects.toThrow(/Cannot find module server\.mjs/);
  });

  it('bounds the surfaced log tail so a runaway service cannot blow up the error', async () => {
    const port = nextPort();
    let message = '';
    try {
      await startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'huge-exit.mjs')],
        cwd: dir,
        repoPath: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // The bound keeps the whole message small (no 250 KB log in a toast)…
    expect(message.length).toBeLessThan(10_000);
    // …but still carries the LAST line, which is where the cause is.
    expect(message).toMatch(/the real error at the very end/);
    expect(message).not.toMatch(/filler line 0/);
  });

  // The same diagnostic, on the OTHER failure shape: the process stays up but
  // never answers the health URL (a slow build, a wrong port in config). The
  // timeout message used to name only the URL and the window; a service that
  // printed its own reason ("listening on 1337, not the allocated 5000") was
  // invisible. The log tail makes the timeout explain itself.
  it('surfaces the process log tail when health never passes', async () => {
    const port = nextPort();
    const logPath = join(dir, 'svc.log');
    await expect(
      startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'stuck.mjs')],
        cwd: dir,
        repoPath: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath,
        healthTimeoutMs: 1200,
      }),
    ).rejects.toThrow(/listening on 1337, not the allocated/);
  });

  // A foreign process on the port answers /health, so health alone cannot tell
  // "my service is up" from "somebody else's is". Port ownership is attributed
  // before spawn: an outside-repository listener is refused, never adopted and
  // never killed.
  it('rejects a foreign healthy listener instead of adopting it', async () => {
    const port = nextPort();
    const outside = mkdtempSync(join(tmpdir(), 'karst-foreign-'));
    const foreign = spawn(process.execPath, [join(dir, 'server.mjs')], {
      cwd: outside,
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
          repoPath: dir,
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
      removeTempDir(outside);
    }
  });

  it('reclaims a same-repository SPA server even when its fallback returns health 200', async () => {
    const port = nextPort();
    const squatter = spawn(process.execPath, [join(dir, 'server.mjs')], {
      cwd: dir,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    try {
      await waitUntilServing(`http://127.0.0.1:${port}/health`);

      const rec = await startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'server.mjs')],
        cwd: dir,
        repoPath: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
      });

      expect(rec.status).toBe('running');
      await new Promise((r) => setTimeout(r, 200));
      expect(alive(squatter.pid!)).toBe(false);
    } finally {
      squatter.kill('SIGKILL');
    }
  });

  // The reported spin failure: a dev server squats the port, answering nothing
  // the health URL asks (a plain FE dev server 404s /health), so the health
  // probe cannot see it and the spawned child dies of EADDRINUSE with exit 1.
  // A squatter running INSIDE the service's repository is a dev server of this
  // repo — startHot reclaims the port from it and starts cleanly.
  it('reclaims the port from a conflicting dev server running in the repo, then starts', async () => {
    const port = nextPort();
    const squatter = spawn(process.execPath, [join(dir, 'deaf.mjs')], {
      cwd: dir,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    try {
      await waitUntilListening(port);

      const reaped: number[] = [];
      const rec = await startHot(store, {
        ticketId: 1,
        service: 'backend',
        command: process.execPath,
        args: [join(dir, 'server.mjs')],
        cwd: dir,
        repoPath: dir,
        env: { PORT: String(port) },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'svc.log'),
        onReclaim: (pid) => reaped.push(pid),
      });

      expect(rec.status).toBe('running');
      expect(reaped).toEqual([squatter.pid!]); // the reap is REPORTED to the caller
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      // the squatter was reaped, not left to fight for the port
      await new Promise((r) => setTimeout(r, 200));
      expect(alive(squatter.pid!)).toBe(false);
    } finally {
      squatter.kill('SIGKILL');
    }
  });

  // The OTHER half of the same situation: the squatter runs OUTSIDE the repo —
  // an unrelated app on the port. Karst never kills a stranger, so the start is
  // refused with the port named, and the squatter survives untouched.
  it('refuses when the port is held by a process outside the repo — never kills a stranger', async () => {
    const port = nextPort();
    const outside = mkdtempSync(join(tmpdir(), 'karst-out-'));
    const squatter = spawn(process.execPath, [join(dir, 'deaf.mjs')], {
      cwd: outside,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    try {
      await waitUntilListening(port);

      await expect(
        startHot(store, {
          ticketId: 1,
          service: 'backend',
          command: process.execPath,
          args: [join(dir, 'server.mjs')],
          cwd: dir,
          repoPath: dir,
          env: { PORT: String(port) },
          host: '127.0.0.1',
          port,
          healthUrl: `http://127.0.0.1:${port}/health`,
          logPath: join(dir, 'svc.log'),
        }),
      ).rejects.toThrow(/is in use by pid \d+ \(not a dev server of this repository\)/);

      await new Promise((r) => setTimeout(r, 200));
      expect(alive(squatter.pid!)).toBe(true); // untouched
      const rows = store.db.prepare('SELECT COUNT(*) AS n FROM servers').get() as { n: number };
      expect(rows.n).toBe(0); // nothing recorded, nothing killed
    } finally {
      squatter.kill('SIGKILL');
    }
  });

  // The same conflict, but the squatter IS a karst-recorded server — another
  // ticket's, answering its OWN health path (not ours). It is attributable and
  // reaped, and its row is retired rather than left claiming a dead pid.
  it('kills a conflicting karst-recorded server of another ticket and marks its row stopped', async () => {
    const port = nextPort();
    const old = await startHot(store, {
      ticketId: 9,
      service: 'frontend',
      command: process.execPath,
      args: [join(dir, 'custom.mjs')],
      cwd: dir,
      repoPath: dir,
      env: { PORT: String(port), HEALTH_PATH: '/fe-health' },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/fe-health`,
      logPath: join(dir, 'fe.log'),
    });

    const rec = await startHot(store, {
      ticketId: 1,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      repoPath: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath: join(dir, 'svc.log'),
    });

    expect(rec.status).toBe('running');
    const row = store.db.prepare('SELECT status, pid FROM servers WHERE id = ?').get(old.id) as {
      status: string;
      pid: number | null;
    };
    expect(row.status).toBe('stopped'); // retired with the kill, not left phantom-running
    expect(row.pid).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(old.pid)).toBe(false);
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
        repoPath: dir,
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
        repoPath: dir,
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
        repoPath: dir,
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

    await stopTicketServers(store, 7);

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

    await stopServer(store, other.id);
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
      repoPath: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath,
    });

    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toMatch(/booting on/);
    expect(tailLog(rec)).toMatch(/booting on/);

    await stopServer(store, rec.id);
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
      repoPath: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath,
    });

    expect(readFileSync(logPath, 'utf8')).toMatch(/booting on/);

    await stopServer(store, rec.id);
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

/**
 * A recorded pid is a recollection, not a handle: the OS may have reissued it to
 * an unrelated process. `stopServer` therefore signals only what
 * `serverIdentity.ts` can still attribute to the recorded server — and retires
 * the row and the container either way.
 */
describe('stopServer attribution', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
    removeContainerMock.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
  });

  /** Insert one running row; only the identity columns vary per case. */
  const rowId = (over: {
    cwd?: string | null;
    startedAt?: string | null;
    container?: string | null;
  } = {}): number => {
    const info = store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at, container)
         VALUES (1, 'backend', '127.0.0.1', 3000, 4242, 'running', '/tmp/x.log', ?, ?, ?)`,
      )
      .run(
        over.cwd ?? '/wt/a',
        over.startedAt ?? '2026-08-03T07:00:00.000Z',
        over.container ?? null,
      );
    return Number(info.lastInsertRowid);
  };

  const rowOf = (id: number): { status: string; pid: number | null } =>
    store.db.prepare('SELECT status, pid FROM servers WHERE id = ?').get(id) as {
      status: string;
      pid: number | null;
    };

  it('signals the recorded pid when it is still attributable', async () => {
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const id = rowId();

    await stopServer(store, id, {
      facts: {
        isAlive: () => true,
        liveCwd: () => ({ path: '/wt/a', deleted: false }),
        processStartMs: () => null,
      },
    });

    expect(signal).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('does not signal a foreign pid, but still marks the row stopped', async () => {
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const id = rowId();

    await stopServer(store, id, {
      facts: {
        isAlive: () => true,
        liveCwd: () => ({ path: '/somewhere/else', deleted: false }),
        processStartMs: () => null,
      },
    });

    expect(signal).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(rowOf(id)).toEqual({ status: 'stopped', pid: null });
  });

  it('does not signal a dead pid, but still marks the row stopped', async () => {
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const id = rowId();

    await stopServer(store, id, {
      facts: {
        isAlive: () => false,
        liveCwd: () => ({ path: '/wt/a', deleted: false }),
        processStartMs: () => null,
      },
    });

    expect(signal).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(rowOf(id)).toEqual({ status: 'stopped', pid: null });
  });

  it('does not signal an unprovable pid, but still marks the row stopped', async () => {
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const id = rowId();

    await stopServer(store, id, {
      facts: {
        isAlive: () => true,
        liveCwd: () => null,
        processStartMs: () => null,
      },
    });

    expect(signal).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(rowOf(id)).toEqual({ status: 'stopped', pid: null });
  });

  it('removes the container even when the pid is not attributable', async () => {
    const id = rowId({ container: 'karst-x' });

    await expect(
      stopServer(store, id, {
        facts: {
          isAlive: () => false,
          liveCwd: () => null,
          processStartMs: () => null,
        },
      }),
    ).resolves.toBeUndefined();

    expect(rowOf(id)).toEqual({ status: 'stopped', pid: null });
    expect(removeContainerMock).toHaveBeenCalledWith('karst-x');
  });
});


/**
 * A container service is spawned like any other — the `docker run` client is a
 * normal child — but the CONTAINER outlives a kill aimed at that client, so the
 * name is the part that has to be recorded and acted on.
 */
describe('supervisor — container services', () => {
  let store: Store;
  let dir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'karst-supervisor-docker-'));
    removeContainerMock.mockClear();
    removeContainerAsyncMock.mockClear();
  });

  afterEach(() => {
    store.close();
    removeTempDir(dir);
  });

  const startContainerService = async (): Promise<{ id: number; port: number }> => {
    const port = nextPort();
    const rec = await startHot(store, {
      ticketId: 1,
      service: 'db',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      repoPath: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath: join(dir, 'db.log'),
      container: 'karst-t1-db',
    });
    expect(rec.container).toBe('karst-t1-db');
    return { id: rec.id, port };
  };

  beforeEach(() => {
    writeFileSync(join(dir, 'server.mjs'), SERVER_SRC);
  });

  it('clears a leftover container of the same name BEFORE spawning', async () => {
    const { id } = await startContainerService();
    // docker refuses a second container under a name already taken, so a
    // container left by a crashed run would make every retry fail.
    expect(removeContainerAsyncMock).toHaveBeenCalledWith('karst-t1-db', expect.anything());
    await stopServer(store, id);
  });

  it('records the container name on the row', async () => {
    const { id } = await startContainerService();
    const row = store.db
      .prepare('SELECT container FROM servers WHERE id = ?')
      .get(id) as { container: string | null };
    expect(row.container).toBe('karst-t1-db');
    await stopServer(store, id);
  });

  it('removes the container when the server is stopped', async () => {
    const { id } = await startContainerService();
    await stopServer(store, id);
    // Killing the attached client does NOT stop the container: without this the
    // container keeps its port bound and its memory held, with nothing pointing
    // at it any more.
    expect(removeContainerMock).toHaveBeenCalledWith('karst-t1-db');
  });

  it('removes the container when the start never becomes healthy', async () => {
    const port = nextPort();
    await expect(
      startHot(store, {
        ticketId: 1,
        service: 'db',
        command: process.execPath,
        args: [join(dir, 'server.mjs')],
        cwd: dir,
        repoPath: dir,
        // Never serves /health 200 within the timeout.
        env: { PORT: String(port), READY_AFTER_MS: '60000' },
        host: '127.0.0.1',
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        logPath: join(dir, 'db.log'),
        container: 'karst-t1-db',
        healthTimeoutMs: 700,
      }),
    ).rejects.toThrow();
    // No `servers` row was inserted, so no stop or reap path will ever learn
    // this container's name: if the failing start does not remove it here, the
    // container keeps running with the port bound and nothing pointing at it.
    expect(removeContainerMock).toHaveBeenCalledWith('karst-t1-db', expect.anything());
  });

  it('removes nothing for a plain command service', async () => {
    const port = nextPort();
    const rec = await startHot(store, {
      ticketId: 2,
      service: 'backend',
      command: process.execPath,
      args: [join(dir, 'server.mjs')],
      cwd: dir,
      repoPath: dir,
      env: { PORT: String(port) },
      host: '127.0.0.1',
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      logPath: join(dir, 'backend.log'),
    });
    expect(rec.container).toBeNull();
    await stopServer(store, rec.id);
    expect(removeContainerMock).not.toHaveBeenCalled();
    expect(removeContainerAsyncMock).not.toHaveBeenCalled();
  });
});
