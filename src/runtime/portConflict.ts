import { connect, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Store } from '../store/db.js';
import {
  attributeServer,
  systemAsyncProcessFacts,
  type ProcessFacts,
  type ProcessFactsSource,
} from './serverIdentity.js';
import { isPathUnder } from './pathScope.js';
import { killTree } from './processTree.js';
import { commandOutput } from './asyncProcess.js';

interface ResolvedAddress {
  address: string;
  family: number;
}

export interface ListenerDiscoveryOptions {
  lookupHost?: (host: string) => Promise<ResolvedAddress[]>;
  timeoutMs?: number;
}

/**
 * Port-conflict handling for `startHot` (869ecy81w).
 *
 * A service's allocated port can be occupied by a process that does NOT answer
 * the health URL — the classic FE dev server that binds its hardcoded port and
 * 404s /health. The health probe cannot see it, and the child `startHot` would
 * spawn dies of EADDRINUSE with exit 1 before ever becoming healthy. The port
 * has to be free BEFORE the spawn, and "free" is a question of who listens, not
 * of who answers.
 *
 * Before giving up, karst tries to RECLAIM the port from processes it can
 * attribute:
 *   - a karst-recorded server — a `servers` row whose pid attributes (of ANY
 *     ticket): a sibling worktree's dev server, or one leaked by an earlier
 *     run. The row is retired with it.
 *   - a process whose live cwd is inside the service's repository: the
 *     main-checkout dev server or any of its worktrees'.
 * Anything else — an unrelated app on the port — is a STRANGER: karst never
 * kills it, and the start is refused with a message naming the port.
 */

/**
 * One TCP connect: does ANYTHING accept connections on this port? Unlike the
 * health probes (`isServing`/`waitForHealth`), a response is not required — a
 * squatter that answers 404 is still a listener, and still blocks the bind.
 * Bounded by `timeoutMs` (a filtered port must not hang the start).
 */
export function isPortOpen(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
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
 * Pids of processes LISTENING on `host:port`. `lsof` on macOS/Linux,
 * `netstat -ano` on Windows. The query is address-scoped: a v6-only listener
 * does not license killing a process when the service uses IPv4. Empty when
 * none are found — or when the platform cannot answer (lsof absent, another
 * user's process, netstat output the parse does not understand): the caller
 * must treat empty-on-occupied as "cannot identify", never as "no one is there".
 * The subprocess is asynchronous and bounded so this preflight never blocks
 * the extension host's event loop or leaves Spin waiting indefinitely.
 */
async function discoverListenerPids(
  host: string,
  port: number,
  options: ListenerDiscoveryOptions = {},
): Promise<number[]> {
  const literalFamily = isIP(host);
  const lookupHost = options.lookupHost ?? ((target) => lookup(target, { all: true }));
  const targets = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await lookupHost(host).catch(() => []);
  if (targets.length === 0) return [];

  if (process.platform === 'win32') {
    const stdout = await commandOutput('netstat', ['-ano', '-p', 'tcp']);
    if (stdout === null) return [];
    const pids: number[] = [];
    for (const line of stdout.split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== 'LISTENING') continue;
      if (!(fields[1] ?? '').endsWith(`:${port}`)) continue;
      const localHost = fields[1]!.slice(0, -`:${port}`.length).replace(/^\[|\]$/g, '');
      const family = isIP(localHost);
      const matchingTarget = targets.some(
        (target) =>
          target.family === family &&
          (localHost === target.address || localHost === (family === 6 ? '::' : '0.0.0.0')),
      );
      if (!matchingTarget) continue;
      const pid = Number(fields[4]);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
    return [...new Set(pids)];
  }
  const families = [...new Set(targets.map(({ family }) => family))];
  const outputs = await Promise.all(
    families.map(async (family) => ({
      family,
      stdout: await commandOutput('lsof', [
        '-nP',
        '-a',
        `-i${family}TCP:${port}`,
        '-sTCP:LISTEN',
        '-Fpn',
      ]),
    })),
  );
  const pids: number[] = [];
  for (const { family, stdout } of outputs) {
    if (stdout === null) continue;
    let pid: number | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        const parsed = Number(line.slice(1));
        pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
        continue;
      }
      if (!line.startsWith('n') || pid === null) continue;
      const suffix = `:${port}`;
      const name = line.slice(1);
      if (!name.endsWith(suffix)) continue;
      const localHost = name.slice(0, -suffix.length).replace(/^\[|\]$/g, '');
      if (
        localHost === '*' ||
        targets.some((target) => target.family === family && target.address === localHost)
      ) {
        pids.push(pid);
      }
    }
  }
  return [...new Set(pids)];
}

export function listenerPids(
  host: string,
  port: number,
  options: ListenerDiscoveryOptions = {},
): Promise<number[]> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (pids: number[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(pids);
    };
    const timer = setTimeout(() => finish([]), Math.max(1, timeoutMs)).unref();
    discoverListenerPids(host, port, options).then(finish, () => finish([]));
  });
}

export interface ReclaimDecision {
  kill: boolean;
  /** The `servers` row to retire alongside the kill (an attributable karst server). */
  rowId?: number;
}

/**
 * May karst kill this listener? Two independent attribution rules, either of
 * which licenses the kill:
 *
 *  1. The pid has a RUNNING `servers` row and `attributeServer` attributes it —
 *     a server karst itself started (another ticket's, or a leaked one). Its
 *     row id is returned so the caller can retire the row with the process.
 *  2. The OS reports the live process's cwd, and it is inside the service's
 *     repository (the main checkout or any of its worktrees) — a dev server
 *     that provably belongs to the repo being started. This is also the catch
 *     for a row whose pid the OS has reissued: the cwd is still live evidence.
 *
 * A non-attributable row is NOT a refusal by itself — the cwd rule is checked
 * after it, so a reissued pid whose new process happens to serve this repo
 * still dies (a dev server of the repo is the ticket's "conflicting process",
 * whatever its pid history). Everything else is a stranger: refused.
 */
export function decideReclaim(
  store: Store,
  pid: number,
  repoPath: string,
  facts: ProcessFacts,
): ReclaimDecision {
  const row = store.db
    .prepare("SELECT id, pid, cwd, started_at FROM servers WHERE pid = ? AND status = 'running'")
    .get(pid) as { id: number; pid: number; cwd: string | null; started_at: string | null } | undefined;

  if (
    row &&
    attributeServer({ pid: row.pid, cwd: row.cwd, startedAt: row.started_at }, facts) ===
      'attributable'
  ) {
    return { kill: true, rowId: row.id };
  }
  const live = facts.liveCwd(pid);
  if (live && isPathUnder(live.path, repoPath)) return { kill: true };
  return { kill: false };
}

/** Resolve each potentially expensive fact once for one listener pid. */
async function snapshotProcessFacts(source: ProcessFactsSource, pid: number): Promise<ProcessFacts> {
  const alive = await source.isAlive(pid);
  if (!alive) {
    return { isAlive: () => false, liveCwd: () => null, processStartMs: () => null };
  }
  const [liveCwd, processStartMs] = await Promise.all([
    source.liveCwd(pid),
    source.processStartMs(pid),
  ]);
  return {
    isAlive: (target) => target === pid && alive,
    liveCwd: (target) => (target === pid ? liveCwd : null),
    processStartMs: (target) => (target === pid ? processStartMs : null),
  };
}

export interface ReclaimOutcome {
  killedPids: number[];
  /** `servers` row ids to retire (killed processes karst had recorded). */
  stoppedRows: number[];
  /** Listeners that must keep the port blocked (`pid: null` = unidentified listener). */
  survivors: { pid: number | null }[];
  /**
   * True only when a bounded re-probe found the port free AFTER the kill pass.
   * The re-probe arbitrates what the kill pass cannot answer synchronously: a
   * fire-and-forget kill (Windows taskkill), a listener that died on its own
   * between identification and the signal, and the kernel's own teardown
   * latency. The caller may spawn only when this is true.
   */
  portFree: boolean;
}

/** How long a killed listener may take to actually release its socket. */
const PORT_RELEASE_MS = 2_000;

/** Wait (bounded) for the port to be free again; true when it is. */
async function recheckFree(host: string, port: number): Promise<boolean> {
  const deadline = Date.now() + PORT_RELEASE_MS;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(host, port))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * One reclaim pass: identify the listeners on a port `startHot` needs, kill
 * every attributable one, and report the rest. The caller decides on the
 * survivors (the port is never free while one remains). `portFree` is settled
 * by a bounded re-probe, so a kill that did not land — a `denied` kill is
 * reported as a survivor, and a `killTree` `unknown` (Windows taskkill,
 * fire-and-forget) is arbitrated by the probe — still blocks the start.
 */
export async function reclaimPort(
  store: Store,
  host: string,
  port: number,
  repoPath: string,
  facts: ProcessFactsSource = systemAsyncProcessFacts,
): Promise<ReclaimOutcome> {
  const outcome: ReclaimOutcome = { killedPids: [], stoppedRows: [], survivors: [], portFree: false };
  const uncertainKills: { pid: number; rowId?: number }[] = [];
  if (!(await isPortOpen(host, port))) return { ...outcome, portFree: true };

  const pids = await listenerPids(host, port);
  if (pids.length === 0) {
    // Occupied but unidentified: reclaiming is impossible, and guessing who
    // holds the port would be a stranger's kill.
    outcome.survivors.push({ pid: null });
    return outcome;
  }

  for (const pid of pids) {
    const decision = decideReclaim(store, pid, repoPath, await snapshotProcessFacts(facts, pid));
    if (!decision.kill) {
      outcome.survivors.push({ pid });
      continue;
    }
    const killed = killTree(pid);
    if (killed === 'denied') {
      outcome.survivors.push({ pid }); // still running, refused — never read as success
      continue;
    }
    if (killed === 'unknown') {
      uncertainKills.push({ pid, rowId: decision.rowId });
      continue;
    }
    outcome.killedPids.push(pid);
    if (decision.rowId !== undefined) outcome.stoppedRows.push(decision.rowId);
  }
  // A survivor was not killed (a stranger, a denied kill, an unidentified
  // listener) — it still holds the port, so no wait settles that: refuse at
  // once. The recheck only arbitrates the killed set (fire-and-forget kills,
  // kernel teardown latency, a listener that died on its own).
  if (outcome.survivors.length === 0) {
    outcome.portFree = await recheckFree(host, port);
    if (outcome.portFree) {
      for (const { pid, rowId } of uncertainKills) {
        if (await facts.isAlive(pid)) {
          outcome.portFree = false;
          outcome.survivors.push({ pid });
          continue;
        }
        outcome.killedPids.push(pid);
        if (rowId !== undefined) outcome.stoppedRows.push(rowId);
      }
    } else {
      outcome.survivors.push(...uncertainKills.map(({ pid }) => ({ pid })));
    }
  }
  return outcome;
}
