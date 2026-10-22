import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * Does something ACCEPT a connection on `host:port` right now? A bind probe can
 * miss a live listener (see `canBind`); a refused connection is the proof that
 * nothing is there. Bounded so a filtered port cannot hang the probe.
 */
function accepts(port: number, host: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port, signal: AbortSignal.timeout(timeoutMs) });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Is this port free? A bind probe alone is NOT proof: on BSD/macOS a listener
 * held on `0.0.0.0` (or on `::1`) still lets a fresh `::` and `127.0.0.1` bind
 * succeed — Node sets SO_REUSEADDR, and the wildcard/specific pairs are
 * independent — so a single family's bind reported a port free that a leaked
 * server was provably serving, and `freePortWindow` handed it to a suite whose
 * `startHot` then refused the stranger. Probe every shape a listener can take:
 * bind the three wildcard/specific sockets AND prove both loopbacks refuse a
 * connection. Windows still needs the `127.0.0.1` bind beside the `::` one: a
 * process listening on `::` answers IPv4, but a fresh `127.0.0.1` bind there is
 * what catches it when the `::` bind happens to succeed.
 */
async function canBind(port: number): Promise<boolean> {
  if (!(await bindable(port))) return false;
  if (!(await bindable(port, '0.0.0.0'))) return false;
  if (!(await bindable(port, '127.0.0.1'))) return false;
  if (await accepts(port, '127.0.0.1')) return false;
  if (await accepts(port, '::1')) return false;
  return true;
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
 *
 * A probe is not enough on its own, though: karst runs one test suite per worktree
 * CONCURRENTLY on the same machine, and every run starts at the same fixed base.
 * Two runs could probe the same window while it was free, then each bind half of
 * it and lose the other half to the "stranger". That is exactly how the baseline
 * suite failed with `127.0.0.1:28100 is in use by pid … (not a dev server of this
 * repository)` in tests 1, 3, 5, 7 and 9 while its neighbours passed: a sibling
 * run had already bound those exact ports. The window is therefore CLAIMED before
 * it is probed — a per-band claim directory naming the owner pid makes concurrent
 * runs choose different windows (see `claimPortBand`).
 */
export async function freePortWindow(
  span: number,
  from: number,
  ceiling = 49_000,
  stride = 20,
  lockDir = join(tmpdir(), 'karst-test-port-bands'),
): Promise<number> {
  // Ceiling: stay under Windows' ephemeral range (49152+), where a window is free
  // when probed and taken by an outbound socket a second later. Linux' ephemeral
  // range starts LOWER — 32768 by default — and that range is what made the
  // server suites flaky in CI: a fixture band inside it (the old 48200–49000)
  // could be grabbed by any outbound socket, including a sibling suite's
  // `listen(0)`, between this probe and a child's bind. Callers therefore choose
  // bands BELOW 32768 (see the `[28000, 29000)` block in the runtime suites), so
  // the window is not in the ephemeral range at all. `stride` then only guards
  // against a genuine leaked listener, deliberately much smaller than `span`:
  // stepping by a whole span would give a 140-port request only two candidate
  // windows below the ceiling, and one busy port anywhere in either would fail
  // the whole suite.
  for (let base = from; base + span <= ceiling; base += stride) {
    if (!claimPortBand(base, span, lockDir)) continue;
    let ok = true;
    for (let port = base; port < base + span; port++) {
      if (!(await canBind(port))) {
        ok = false;
        break;
      }
    }
    if (ok) return base;
    // Claimed but occupied by a leaked listener: hand the window back so a later
    // stride step (or a later run) may still use it.
    releasePortBand(base, span, lockDir);
  }
  throw new Error(
    `no free window of ${span} ports in [${from}, ${ceiling}] — a previous run probably ` +
      `leaked servers; kill stray fixture processes and retry`,
  );
}

/** A claim with no readable owner is only stale once it is this old. */
const CLAIM_STALE_MS = 10 * 60_000;

/** Is a pid still running? EPERM means "running, owned by somebody else". */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when an existing claim directory belongs to nobody alive. */
function claimIsStale(path: string): boolean {
  let owner = Number.NaN;
  try {
    owner = Number(readFileSync(join(path, 'pid'), 'utf8').trim());
  } catch {
    // No pid file yet: either its writer is mid-claim (leave it alone) or it
    // died between `mkdir` and the write (reclaim once it is old enough).
    try {
      return Date.now() - statSync(path).mtimeMs > CLAIM_STALE_MS;
    } catch {
      return true;
    }
  }
  if (owner === process.pid) return false;
  return !pidAlive(owner);
}

/**
 * Claim `[base, base + span)` for this process; false when another LIVE run holds
 * it. `mkdir` is atomic across processes, which is what makes the claim a lock
 * rather than a hint. Nothing has to release on shutdown: a claim whose pid is
 * gone reads as stale and is reclaimed by whoever needs the window next.
 */
export function claimPortBand(base: number, span: number, dir: string): boolean {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${base}-${span}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'pid'), String(process.pid));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      if (!claimIsStale(path)) return false;
      rmSync(path, { recursive: true, force: true });
    }
  }
  return false;
}

/** Give a claimed window back (it was probed and found occupied). */
export function releasePortBand(base: number, span: number, dir: string): void {
  rmSync(join(dir, `${base}-${span}`), { recursive: true, force: true });
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
