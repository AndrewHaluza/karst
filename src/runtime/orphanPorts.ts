import { join } from 'node:path';
import type { Store } from '../store/db.js';
import { isPortOpen as tcpIsPortOpen, listenerPids as tcpListenerPids } from './portConflict.js';
import { killTree, type KillOutcome } from './processTree.js';
import { portsIn } from './portProbe.js';
import { isPathUnder } from './pathScope.js';
import { systemAsyncProcessFacts, type ProcessFactsSource } from './serverIdentity.js';
import { collectTree } from './procTreeCost.js';
import { readProcSnapshot, type ProcSnapshot } from './procSnapshot.js';

/**
 * The last orphan class nothing else can reach: a server karst started whose
 * `servers` row is GONE.
 *
 * `stopServersUnder` reaps at removal, `reapStaleServers` reaps rows whose
 * directory vanished — both work from a row. When the row went with the ticket
 * (archived, deleted, or written by a build that predates `servers.cwd`), the
 * process is invisible to every one of them: reparented to init, holding a port
 * of karst's own range, serving a worktree nobody will ever spin again. The
 * reported pair had held their ports for 13 hours and two days.
 *
 * The evidence here is the PROCESS, not a recollection: karst asks who is
 * listening on its own port ranges and where that process is running, and acts
 * only on one whose live cwd is inside a `.karst/worktrees/` directory of a
 * repository this manifest declares. That is a path only karst creates, so a
 * process running there is a process karst started. Everything else — a cwd the
 * OS will not report, a listener anywhere else, a pid a running row still
 * claims — is left strictly alone.
 *
 * "Claims" is the row's whole process TREE, not just its recorded pid: the
 * recorded pid is the spawn LEADER, and the process holding the port is
 * commonly a DESCENDANT of it (`npm run dev` → shell → Vite). Claiming only the
 * leader made that descendant indistinguishable from an orphan, so the first
 * sweep after a window reload SIGKILLed a healthy server's listener while its
 * own row still said `running`.
 */

export interface OrphanReap {
  pid: number;
  port: number;
  /** The worktree directory the process was running in. */
  cwd: string;
  outcome:
    /** The process group was signalled (or was already gone). */
    | 'killed'
    /** The kill was REFUSED (EPERM): still running, and reported as such. */
    | 'kill-failed';
}

export interface OrphanReapOptions {
  host: string;
  /** The port windows karst allocates from — nothing outside them is examined. */
  ranges: readonly (readonly [number, number])[];
  /** Repository roots of the manifest; their `.karst/worktrees/` are the scope. */
  repoPaths: readonly string[];
  /** Injected for tests; default is the TCP connect probe. */
  isPortOpen?: (host: string, port: number) => Promise<boolean>;
  /** Injected for tests; default is the `lsof`/`netstat` discovery. */
  listenerPids?: (host: string, port: number) => Promise<number[]>;
  /** OS probes; injected so tests never depend on this machine's processes. */
  facts?: ProcessFactsSource;
  /**
   * Injected for tests; default is one async `ps` snapshot (`readProcSnapshot`).
   * Expands each running row's recorded pid — the spawn LEADER — into the whole
   * process tree it heads, so the listener DESCENDANT that actually holds the
   * port is claimed too. `null` means the OS did not answer (or cannot: Windows
   * has no `ps`); the sweep then falls back to the rows' recorded directories.
   */
  processSnapshot?: () => Promise<ProcSnapshot | null>;
  /** Injected for tests; default sends SIGKILL to the process group. */
  kill?: (pid: number) => KillOutcome;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[runtime]`.
   * Absent → no debug lines.
   */
  debug?: (message: string) => void;
}

/**
 * The directories karst puts worktrees in, one per repository checkout, deduped
 * — repository ENTRIES may share a `repoPath` (a monorepo with several runnable
 * processes), and that is one root, not two.
 */
export function worktreeRootsOf(repoPaths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const repoPath of repoPaths) roots.add(join(repoPath, '.karst', 'worktrees'));
  return [...roots];
}

/** One async `ps` snapshot, or null where the OS did not answer or cannot. */
async function systemProcessSnapshot(): Promise<ProcSnapshot | null> {
  const result = await readProcSnapshot();
  return result.supported ? result.snapshot : null;
}

/**
 * Everything the running `servers` rows claim: each recorded pid AND the live
 * descendants of each, plus the directories those rows were spawned in.
 *
 * The recorded pid is the spawn LEADER (`supervisor.ts` writes the pid `spawn`
 * returned), while the process the user actually reaches — the one holding the
 * allocated port — is commonly a DESCENDANT (`npm run dev` → shell → Vite).
 * Claiming only the leader left that descendant looking exactly like an orphan:
 * a karst worktree cwd, an allocated port, and no running pid that matched it.
 * The tree is what a row really claims, so the tree is claimed here.
 *
 * A snapshot that did not arrive (or a platform that cannot take one) is not
 * fatal: the recorded directories remain, and `reapOrphanedPorts` uses them as
 * a subprocess-free fallback via the worktree-containment rule.
 */
interface RunningClaims {
  /** Recorded leader pids, plus the live descendants of each. */
  pids: Set<number>;
  /** Directories the running rows were spawned in (`servers.cwd`). */
  cwds: string[];
}

async function runningClaims(
  store: Store,
  snapshotOf: () => Promise<ProcSnapshot | null>,
): Promise<RunningClaims> {
  const rows = store.db
    .prepare("SELECT pid, cwd FROM servers WHERE status = 'running' AND pid IS NOT NULL")
    .all() as { pid: number; cwd: string | null }[];
  const pids = new Set(rows.map((r) => r.pid));
  const cwds: string[] = [];
  for (const row of rows) if (row.cwd) cwds.push(row.cwd);

  let snapshot: ProcSnapshot | null = null;
  try {
    snapshot = await snapshotOf();
  } catch {
    snapshot = null; // "the OS did not answer" — never a reason to act
  }
  if (snapshot) {
    for (const row of rows) {
      // The recorded pid is usually still alive (a healthy server). When it is,
      // its tree names the descendant that holds the port. When it is not, the
      // tree is empty and the cwd fallback covers the row instead.
      for (const rec of collectTree(snapshot, row.pid)) pids.add(rec.pid);
    }
  }
  return { pids, cwds };
}

/**
 * Kill every process holding a port of karst's ranges from inside a karst
 * worktree that no running row accounts for, and report each one.
 *
 * Reported, never silent, and stated as the OUTCOME: a refused kill is
 * `kill-failed` and means the orphan is still there — the one thing that must
 * never read as a stop that happened. A pid holding several ports is signalled
 * ONCE and reported per port, because the ports are what the user lost.
 */
export async function reapOrphanedPorts(
  store: Store,
  options: OrphanReapOptions,
): Promise<OrphanReap[]> {
  const isOpen = options.isPortOpen ?? ((h, p) => tcpIsPortOpen(h, p));
  const discover = options.listenerPids ?? ((h, p) => tcpListenerPids(h, p));
  const facts = options.facts ?? systemAsyncProcessFacts;
  const kill = options.kill ?? killTree;
  const roots = worktreeRootsOf(options.repoPaths);
  if (roots.length === 0) return [];

  const snapshotOf = options.processSnapshot ?? systemProcessSnapshot;
  const claims = await runningClaims(store, snapshotOf);
  // The directories that may vouch for a listener without a process snapshot:
  // only a row spawned INSIDE a worktree. A baseline row records the repository
  // checkout, which CONTAINS every worktree — letting it vouch by directory
  // would spare every orphan beneath it.
  const claimedWorktreeCwds = claims.cwds.filter((cwd) =>
    roots.some((root) => isPathUnder(cwd, root)),
  );
  // One verdict per pid: a leaked service typically holds a pair of ports (an
  // http and a grpc slot), and signalling its group twice is at best noise and
  // at worst a signal aimed at a pid the OS has already reissued.
  const verdict = new Map<number, OrphanReap['outcome'] | 'spared'>();
  /** Each acted-on pid's directory, so its other ports report the same tree. */
  const cwdOf = new Map<number, string>();
  const reaped: OrphanReap[] = [];

  for (const port of portsIn(options.ranges)) {
    let open = false;
    try {
      open = await isOpen(options.host, port);
    } catch {
      continue; // cannot tell: never act on a port karst could not read
    }
    if (!open) continue;

    let pids: number[] = [];
    try {
      pids = await discover(options.host, port);
    } catch {
      continue;
    }

    for (const pid of pids) {
      // A live, tracked server — the recorded leader or any descendant of it.
      if (claims.pids.has(pid)) continue;

      const known = verdict.get(pid);
      if (known === 'spared') continue;
      if (known !== undefined) {
        reaped.push({ pid, port, cwd: cwdOf.get(pid)!, outcome: known });
        continue;
      }

      // `liveCwd` is sync on some sources and async on others; awaiting covers
      // both, and a probe that throws is read as "the OS will not say".
      let live: Awaited<ReturnType<ProcessFactsSource['liveCwd']>> = null;
      try {
        live = await facts.liveCwd(pid);
      } catch {
        live = null;
      }
      // An unreported cwd is not evidence of anything. This sweep signals only
      // on positive proof that the process runs inside a karst worktree.
      if (!live || !roots.some((root) => isPathUnder(live.path, root))) {
        verdict.set(pid, 'spared');
        continue;
      }
      // The fallback when no process snapshot named this pid: a running row
      // spawned in the SAME worktree vouches for a descendant running one level
      // deeper (`<worktree>` → `<worktree>/packages/app`). Scoped to worktree
      // directories, so a repository-root row cannot vouch for all of them.
      if (claimedWorktreeCwds.some((cwd) => isPathUnder(live.path, cwd))) {
        verdict.set(pid, 'spared');
        options.debug?.(
          `[runtime] orphan sweep: pid ${pid} holds ${options.host}:${port} from ${live.path} ` +
            `— inside a running row's worktree — sparing`,
        );
        continue;
      }

      options.debug?.(
        `[runtime] orphan sweep: pid ${pid} holds ${options.host}:${port} from ${live.path} ` +
          `with no running server row — reaping`,
      );
      let outcome: OrphanReap['outcome'];
      try {
        outcome = kill(pid) === 'denied' ? 'kill-failed' : 'killed';
      } catch {
        outcome = 'kill-failed';
      }
      verdict.set(pid, outcome);
      cwdOf.set(pid, live.path);
      reaped.push({ pid, port, cwd: live.path, outcome });
    }
  }
  return reaped;
}

/** One line per orphan, for an output channel. Names the port and the tree. */
export function describeOrphanReap(s: OrphanReap): string {
  return s.outcome === 'killed'
    ? `karst: stopped orphaned process (pid ${s.pid}) holding port ${s.port} — it was left by ${s.cwd}`
    : `karst: could NOT stop orphaned process (pid ${s.pid}) holding port ${s.port} (${s.cwd}). It is still running.`;
}
