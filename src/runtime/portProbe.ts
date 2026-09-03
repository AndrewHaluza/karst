import type { Store } from '../store/db.js';
import {
  isPortOpen as tcpIsPortOpen,
  listenerPids as tcpListenerPids,
  decideReclaim,
  snapshotProcessFacts,
} from './portConflict.js';
import { systemAsyncProcessFacts, type ProcessFactsSource } from './serverIdentity.js';

/**
 * Live-listener discovery for the port ALLOCATOR (§7.2 step 2).
 *
 * `port_allocations` records what karst has handed out, which is not the same
 * question as what is actually bound: a leaked server from a worktree nobody
 * will spin again, a process started outside karst, a service a developer ran by
 * hand — all hold a port the allocator believes is free, and the spin that draws
 * it dies of EADDRINUSE inside the child, where the only symptom karst sees is a
 * health check that never passes.
 *
 * So the allocator is seeded with the ports something is LISTENING on, and skips
 * them exactly as it skips its own records. This is deliberately advisory and
 * best-effort: the probe is bounded by an overall budget, a probe that throws
 * counts as free, and an expired budget yields whatever was learned so far.
 * Never blocking a spin matters more than a complete answer — `startHot` still
 * attributes and reclaims whatever is on the port it is handed
 * (`runtime/portConflict.ts`), so a missed listener is a slower failure, while a
 * probe that hung or threw would be a spin that never starts at all.
 */

export interface PortProbeOptions {
  /** Injected for tests; defaults to the TCP connect probe `startHot` uses. */
  isPortOpen?: (host: string, port: number) => Promise<boolean>;
  /** How many ports are probed at once. */
  concurrency?: number;
  /** Total wall-clock budget for the whole sweep. */
  budgetMs?: number;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[runtime]`.
   * Absent → no debug lines.
   */
  debug?: (message: string) => void;
}

const DEFAULT_CONCURRENCY = 32;
const DEFAULT_BUDGET_MS = 3_000;

/**
 * Every port covered by `ranges`, ascending and deduplicated. An inverted range
 * (`max < min`) contributes nothing rather than looping — port ranges come from
 * a hand-edited manifest, and a probe is not the place to reject one.
 */
export function portsIn(ranges: readonly (readonly [number, number])[]): number[] {
  const ports = new Set<number>();
  for (const [min, max] of ranges) {
    for (let port = min; port <= max; port++) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Ports in `ranges` that something is already listening on. Best-effort by
 * construction: bounded concurrency, a total budget, and every per-port failure
 * treated as "free" — see the module comment for why a partial answer is the
 * right one here.
 */
export async function probeBusyPorts(
  host: string,
  ranges: readonly (readonly [number, number])[],
  options: PortProbeOptions = {},
): Promise<Set<number>> {
  const ports = portsIn(ranges);
  const busy = new Set<number>();
  if (ports.length === 0) return busy;

  const probe = options.isPortOpen ?? ((h, p) => tcpIsPortOpen(h, p));
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const deadline = Date.now() + Math.max(1, options.budgetMs ?? DEFAULT_BUDGET_MS);

  let next = 0;
  const expired = new Promise<'expired'>((resolve) =>
    setTimeout(() => resolve('expired'), Math.max(1, deadline - Date.now())).unref(),
  );

  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() >= deadline) return;
      const index = next++;
      if (index >= ports.length) return;
      const port = ports[index]!;
      try {
        if (await probe(host, port)) busy.add(port);
      } catch {
        // A probe that cannot answer is not evidence of a listener; leaving the
        // port allocatable keeps the failure in `startHot`, which can attribute
        // and reclaim, rather than silently shrinking the range.
      }
    }
  }

  const workers = Promise.all(
    Array.from({ length: Math.min(concurrency, ports.length) }, () => worker()),
  );
  // The budget bounds the SWEEP, not each probe: a single probe that hangs past
  // the deadline must not hold the spin, so the race resolves on whichever comes
  // first and `busy` is read as it stands.
  await Promise.race([workers, expired]);
  if (busy.size > 0) {
    options.debug?.(
      `[runtime] port probe: ${busy.size} of ${ports.length} port(s) already listening ` +
        `(${[...busy].sort((a, b) => a - b).join(', ')})`,
    );
  }
  return busy;
}

export interface PortsToAvoidOptions extends PortProbeOptions {
  /** Injected for tests; defaults to the `lsof`/`netstat` discovery. */
  listenerPids?: (host: string, port: number) => Promise<number[]>;
  /** OS probes; injected so tests never depend on this machine's processes. */
  facts?: ProcessFactsSource;
}

/**
 * The ports the allocator must skip: the busy ones karst could NOT reclaim.
 *
 * Not every occupied port is a port to avoid, and the difference is the whole
 * design. A dev server of one of these repositories — including a server karst
 * itself leaked — is RECLAIMABLE: `startHot` attributes it, kills it, and the
 * service starts on that same port. Steering around it instead would leave the
 * leaked process holding a port of the range for as long as it lives, which is
 * how a 100-port range quietly becomes a 90-port one.
 *
 * What must be steered around is everything karst will never signal: a
 * stranger's process, a karst BASELINE server (a shared singleton, never one
 * ticket's to kill), and an occupied port whose listener cannot be identified at
 * all. Those block the bind and no reclaim can clear them — before this, the
 * allocator handed such a port out anyway and the spin died of EADDRINUSE inside
 * the child, reported as a health check that never passed.
 *
 * The reclaim decision is `decideReclaim` (`runtime/portConflict.ts`) — the same
 * rule that will run at spawn, asked once per hot repository, so a port licensed
 * for reclaim by ANY of them stays allocatable. Best-effort like the probe:
 * discovery that cannot answer leaves the port avoided, which costs one port and
 * never a spin.
 */
export async function portsToAvoid(
  store: Store,
  host: string,
  ranges: readonly (readonly [number, number])[],
  repoPaths: readonly string[],
  options: PortsToAvoidOptions = {},
): Promise<Set<number>> {
  const busy = await probeBusyPorts(host, ranges, options);
  if (busy.size === 0) return busy;

  const discover = options.listenerPids ?? ((h, p) => tcpListenerPids(h, p));
  const facts = options.facts ?? systemAsyncProcessFacts;
  const avoid = new Set<number>();

  for (const port of busy) {
    let reclaimable = false;
    try {
      const pids = await discover(host, port);
      for (const pid of pids) {
        const snapshot = await snapshotProcessFacts(facts, pid);
        if (repoPaths.some((repoPath) => decideReclaim(store, pid, repoPath, snapshot).kill)) {
          reclaimable = true;
          break;
        }
      }
    } catch {
      // Cannot tell who holds it — treat as unreclaimable and steer around it.
    }
    if (!reclaimable) avoid.add(port);
  }
  if (avoid.size > 0) {
    options.debug?.(
      `[runtime] port probe: avoiding ${avoid.size} occupied port(s) karst cannot reclaim ` +
        `(${[...avoid].sort((a, b) => a - b).join(', ')})`,
    );
  }
  return avoid;
}
