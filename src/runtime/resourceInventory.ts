import { attributeServer, type Attribution, type ProcessFacts, type ProcessFactsSource, type ServerIdentity } from './serverIdentity.js';
import { collectTree, sumCosts, treeCost, type TreeCost } from './procTreeCost.js';
import type { ProcSnapshot } from './procSnapshot.js';

/**
 * Turn one snapshot plus the known-pid sources into the three lanes the
 * resource monitor renders: attributed rows, unattributed heavy hitters, and
 * the bounded cwd confirmations the waste rules need.
 *
 * The inventory OBSERVES. It calls nothing mutating — no `killTree`, no store
 * writes. Attribution is decided by `attributeServer` (the one implementation
 * of that rule); this module is the one adapter that turns the async probes
 * `ProcessFactsSource` offers into the sync `ProcessFacts` shape the rule
 * requires.
 */

/** A pid karst believes it started, and what it belongs to. */
export interface KnownPid {
  pid: number;
  kind: 'server' | 'agent' | 'gate' | 'session';
  ticketId: number | null;
  /** Repository name for a server; the call site label for an agent/gate; 'Session' for a session. */
  label: string | null;
  /** Only servers carry an identity row; other kinds are trusted by construction. */
  identity?: ServerIdentity;
  /** `servers.id`, present only for `kind: 'server'` — what a Kill acts on. */
  serverId?: number;
}

export interface AttributedRow {
  pid: number;
  kind: KnownPid['kind'];
  ticketId: number | null;
  label: string | null;
  serverId: number | null;
  attribution: Attribution;
  cost: TreeCost | null;
  cwd: string | null;
  comm: string;
}

export interface UnattributedRow {
  pid: number;
  comm: string;
  cost: TreeCost;
  /** Confirmed live cwd, when a bounded probe was spent on it. */
  cwd: string | null;
  /** The live directory was removed out from under the process. */
  cwdDeleted: boolean;
}

export interface Inventory {
  takenMs: number;
  attributed: AttributedRow[];
  unattributed: UnattributedRow[];
  /** Sum across attributed rows only — karst's own footprint. */
  totals: { rssBytes: number; cpuPct: number | null };
}

export const UNATTRIBUTED_TOP_N = 5;
export const HEAVY_RSS_BYTES = 300 * 1024 * 1024;
export const HEAVY_CPU_PCT = 25;
export const MAX_CWD_PROBES_PER_TICK = 3;

export async function buildInventory(opts: {
  snapshot: ProcSnapshot;
  previous: ProcSnapshot | null;
  known: readonly KnownPid[];
  facts: ProcessFactsSource;
  /** Probe live cwds for heavy unknowns. False on the fast lane. */
  confirmCwd: boolean;
  debug?: (message: string) => void;
}): Promise<Inventory> {
  const { snapshot, previous, known, facts, confirmCwd, debug } = opts;
  debug?.(`[resources] inventory: ${known.length} known pids, ${snapshot.records.size} processes`);

  const attributed: AttributedRow[] = [];
  const covered = new Set<number>();
  const seen = new Set<number>();

  for (const entry of known) {
    const { pid } = entry;
    if (pid == null || !Number.isInteger(pid) || pid <= 0) continue;
    if (seen.has(pid)) continue; // a duplicate pid is counted once, first entry wins
    seen.add(pid);

    const cost = treeCost(snapshot, previous, pid);
    let attribution: Attribution;
    if (entry.identity !== undefined) {
      const [alive, live, started] = await Promise.all([
        facts.isAlive(pid),
        facts.liveCwd(pid),
        facts.processStartMs(pid),
      ]);
      const resolved: ProcessFacts = {
        isAlive: () => alive,
        liveCwd: () => live,
        processStartMs: () => started,
      };
      attribution = attributeServer(entry.identity, resolved);
    } else {
      attribution = snapshot.records.has(pid) ? 'attributable' : 'dead';
    }

    attributed.push({
      pid,
      kind: entry.kind,
      ticketId: entry.ticketId,
      label: entry.label,
      serverId: entry.serverId ?? null,
      attribution,
      cost,
      cwd: entry.identity?.cwd ?? null,
      comm: snapshot.records.get(pid)?.comm ?? '',
    });

    // The whole tree of a known pid is covered — a child of a known server must
    // never also appear as an unattributed heavy hitter.
    for (const rec of collectTree(snapshot, pid)) covered.add(rec.pid);
  }

  // Unattributed candidates: every record not covered by a known tree, minus
  // ourselves and pid 1. A tree is counted once at its top: a candidate whose
  // ppid is itself a candidate is a child of another candidate, not a root.
  const candidateSet = new Set<number>();
  for (const pid of snapshot.records.keys()) {
    if (covered.has(pid)) continue;
    if (pid === process.pid || pid === 1) continue;
    candidateSet.add(pid);
  }
  const roots: number[] = [];
  for (const pid of candidateSet) {
    const record = snapshot.records.get(pid)!;
    if (!candidateSet.has(record.ppid)) roots.push(pid);
  }

  const candidates: UnattributedRow[] = [];
  for (const pid of roots) {
    const cost = treeCost(snapshot, previous, pid);
    if (cost === null) continue;
    candidates.push({
      pid,
      comm: snapshot.records.get(pid)!.comm,
      cost,
      cwd: null,
      cwdDeleted: false,
    });
  }
  candidates.sort((a, b) => b.cost.rssBytes - a.cost.rssBytes);
  const unattributed = candidates.slice(0, UNATTRIBUTED_TOP_N);

  let probes = 0;
  if (confirmCwd) {
    for (const row of unattributed) {
      if (probes >= MAX_CWD_PROBES_PER_TICK) break;
      const heavy =
        row.cost.rssBytes > HEAVY_RSS_BYTES ||
        (row.cost.cpuPct !== null && row.cost.cpuPct > HEAVY_CPU_PCT);
      if (!heavy) continue;
      debug?.(`[resources] cwd probe: pid ${row.pid} (rss ${row.cost.rssBytes})`);
      const live = await facts.liveCwd(row.pid);
      if (live !== null) {
        row.cwd = live.path;
        row.cwdDeleted = live.deleted;
      }
      probes += 1;
    }
  }

  const totals = sumCosts(
    attributed.map((row) => row.cost).filter((cost): cost is TreeCost => cost !== null),
  );

  debug?.(
    `[resources] inventory: ${attributed.length} attributed, ${unattributed.length} unattributed, totals rss=${totals.rssBytes} cpu=${totals.cpuPct === null ? 'null' : totals.cpuPct}`,
  );

  return { takenMs: snapshot.takenMs, attributed, unattributed, totals };
}
