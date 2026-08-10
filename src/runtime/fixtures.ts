import { rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';

/** Can this port be bound on `host` right now? */
function bindable(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    const done = (): void => void srv.close(() => resolve(true));
    if (host === undefined) srv.listen(port, done);
    else srv.listen(port, host, done);
  });
}

/**
 * Is this port free? Both binds are needed: Windows lets a fresh 127.0.0.1 bind
 * succeed while a process already listens on `::` for the same port — and that
 * process still answers IPv4 connections, so the 127.0.0.1 probe alone reports a
 * port free that a leftover server is provably serving.
 */
async function canBind(port: number): Promise<boolean> {
  return (await bindable(port)) && (await bindable(port, '127.0.0.1'));
}

/**
 * Lowest base at/after `from` where `span` consecutive ports are ALL bindable.
 *
 * Fixture ports used to be hardcoded counters, which made every suite that starts
 * a server hostage to a single leaked process: a run interrupted mid-start (Ctrl-C,
 * a vitest timeout firing while a child is still booting) leaves a detached server
 * holding a port, and every later run then found a stranger on a fixture port. The
 * symptom surfaced far from the cause — a health check passing against the foreign
 * listener, an assertion about start ORDER failing. Probing for a free window is
 * what makes a leaked server harmless instead of poisoning the port forever.
 */
export async function freePortWindow(
  span: number,
  from: number,
  ceiling = 49_000,
  stride = 20,
): Promise<number> {
  // Ceiling: stay under Windows' ephemeral range (49152+), where a window is free
  // when probed and taken by an outbound socket a second later. Linux starts its
  // range at 32768, so there is no range to escape there — hence `stride`, which
  // is deliberately much smaller than `span`: stepping by a whole span would give
  // a 140-port request only two candidate windows below the ceiling, and one
  // outbound connection anywhere in either would fail the whole suite.
  for (let base = from; base + span <= ceiling; base += stride) {
    let ok = true;
    for (let port = base; port < base + span; port++) {
      if (!(await canBind(port))) {
        ok = false;
        break;
      }
    }
    if (ok) return base;
  }
  throw new Error(
    `no free window of ${span} ports in [${from}, ${ceiling}] — a previous run probably ` +
      `leaked servers; kill stray fixture processes and retry`,
  );
}

/**
 * Delete a test temp dir, tolerating a directory Windows has briefly pinned.
 *
 * A process's current directory pins that directory on Windows, and the pin
 * outlives the process by tens of milliseconds. A suite that spawns a server with
 * `cwd: dir`, kills it, and deletes `dir` therefore loses a race it always wins on
 * POSIX — the process reports gone, then `rmdir` fails with EBUSY.
 *
 * `fs.rmSync`'s own `maxRetries` does NOT cover this: its recursive path tries
 * `rmdir` on the root first and gives up on EBUSY without ever retrying, so the
 * call fails in about a millisecond no matter what retry budget it was given.
 *
 * Test-support only, deliberately: this sleeps between attempts, and nothing in
 * the extension host may block its event loop (see CLAUDE.md). Product code that
 * removes a directory keeps failing loudly instead.
 */
export function removeTempDir(dir: string, attempts = 40, delayMs = 25): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      sleepSync(delayMs);
    }
  }
}

/**
 * Poll until something ACCEPTS connections on `port` — any response at all,
 * because a fixture squatter may deliberately answer 404 (a 404 is still proof
 * of a listener). The health polls cannot serve here: they require a 2xx, which
 * is exactly the shape of listener this helper exists to wait for.
 */
export async function waitUntilListening(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = (): Promise<boolean> =>
    new Promise((resolve) => {
      const sock = connect({ host: '127.0.0.1', port });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        resolve(false);
      });
    });
  for (;;) {
    if (await tryOnce()) return;
    if (Date.now() > deadline) throw new Error(`fixture never listened on ${port}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Block this thread for `ms` without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
